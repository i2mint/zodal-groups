/**
 * S7 hardening: symlinks, other processes, unknown fields, migrations, file mode, stale temps.
 * Each case failed before the fix it guards.
 */

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { edgeId, makeEdge, nodeId } from '@zodal/groups-core';
import { createFsGroupStore, ManifestError, MANIFEST_FORMAT, nodeManifestIO, serializeManifest, type ManifestIO } from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string) => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}`) });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'groups-store-fs-hard-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('symlinks', () => {
  it('two stores reaching one manifest through a symlinked directory lose no write', async () => {
    const real = join(dir, 'real');
    await mkdir(real);
    await symlink(real, join(dir, 'link'));
    const a = createFsGroupStore({ path: join(real, 'groups.json') });
    const b = createFsGroupStore({ path: join(dir, 'link', 'groups.json') });
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).apply({ added: [e('bucket', `item-${i}`)] })));
    expect((await a.load()).edges.size).toBe(40);
  });

  it('a symlinked manifest stays a symlink; its target is what gets updated', async () => {
    const target = join(dir, 'data', 'real.json');
    await mkdir(join(dir, 'data'));
    await createFsGroupStore({ path: target }).apply({ added: [e('g', 'a')] });
    const link = join(dir, 'groups.json');
    await symlink(target, link);
    expect((await createFsGroupStore({ path: link }).apply({ added: [e('g', 'b')] })).ok).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, 'utf8')).edges).toHaveLength(2);
  });
});

describe('another process writing the manifest', () => {
  it('is detected before the rename: a conflict, and the other write survives', async () => {
    const path = join(dir, 'groups.json');
    await createFsGroupStore({ path }).apply({ added: [e('g', 'a')] });
    const real = nodeManifestIO();
    let interfere = true;
    const theirs = serializeManifest({ nodes: [], edges: [e('theirs', 'x')], revision: 9 });
    const io: ManifestIO = {
      read: async (p) => {
        const text = await real.read(p);
        if (interfere) {
          interfere = false;
          await writeFile(p, theirs); // the other process lands between our read and our rename
        }
        return text;
      },
      write: real.write,
    };
    const r = await createFsGroupStore({ path, io }).apply({ added: [e('g', 'b')] }, { expectedRevision: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0]!.code).toBe('conflict');
      expect(r.violations[0]!.expectedRevision).toBe(1);
      expect(r.violations[0]!.actualRevision).toBe(9); // re-read: theirs, not our stale 1
    }
    expect(await readFile(path, 'utf8')).toBe(theirs);
  });
});

describe('a deleted and re-created manifest is a new history', () => {
  it('an (epoch, revision) from the old file is refused, even when the revision number matches', async () => {
    const path = join(dir, 'groups.json');
    const store = createFsGroupStore({ path });
    const old = await store.apply({ added: [e('g', 'a')] });
    if (!old.ok) throw new Error('seed');
    await rm(path);
    const fresh = await store.apply({ added: [e('h', 'z')] }); // revision 1 again
    if (!fresh.ok) throw new Error('fresh');
    expect(fresh.value.revision).toBe(old.value.revision);
    expect(fresh.value.epoch).not.toBe(old.value.epoch);
    const stale = await store.apply(old.value.inverse, { expectedRevision: old.value.revision, expectedEpoch: old.value.epoch });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.violations[0]!.code).toBe('conflict');
    expect(JSON.parse(await readFile(path, 'utf8')).epoch).toBe(fresh.value.epoch);
  });
});

describe('the manifest format evolves', () => {
  it('keeps top-level fields it does not know', async () => {
    const path = join(dir, 'groups.json');
    await writeFile(path, JSON.stringify({ format: MANIFEST_FORMAT, version: 1, nodes: [], edges: [], 'x-app': { theme: 'dark' } }));
    await createFsGroupStore({ path }).apply({ added: [e('g', 'a')] });
    expect(JSON.parse(await readFile(path, 'utf8'))['x-app']).toEqual({ theme: 'dark' });
  });

  it('migrates an older version through the migrations map, and writes the current one', async () => {
    const path = join(dir, 'groups.json');
    await writeFile(path, JSON.stringify({ format: MANIFEST_FORMAT, version: 0, links: [['g', 'a']] }));
    const migrations = {
      0: (m: Record<string, unknown>) => ({
        format: m.format,
        version: 1,
        nodes: [],
        edges: (m.links as [string, string][]).map(([p, c]) => e(p, c)),
      }),
    };
    const store = createFsGroupStore({ path, migrations });
    expect([...(await store.load()).edges.keys()]).toEqual(['g>a']);
    await store.apply({ added: [e('g', 'b')] });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('refuses an older version it has no migration for', async () => {
    const path = join(dir, 'groups.json');
    await writeFile(path, JSON.stringify({ format: MANIFEST_FORMAT, version: 0, nodes: [], edges: [] }));
    await expect(createFsGroupStore({ path }).load()).rejects.toThrow(ManifestError);
    await expect(createFsGroupStore({ path }).load()).rejects.toThrow(/no migration from version 0/);
  });
});

describe('files', () => {
  it('keeps the manifest file mode across writes', async () => {
    const path = join(dir, 'groups.json');
    await createFsGroupStore({ path }).apply({ added: [e('g', 'a')] });
    await chmod(path, 0o600);
    await createFsGroupStore({ path }).apply({ added: [e('g', 'b')] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('creates a new manifest with the given mode', async () => {
    const path = join(dir, 'private.json');
    await createFsGroupStore({ path, mode: 0o600 }).apply({ added: [e('g', 'a')] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("removes temp files a dead process left behind, and keeps a live process's", async () => {
    const path = join(dir, 'groups.json');
    const deadPid = await (async () => {
      for (let pid = 4_000_000; ; pid++) {
        try {
          process.kill(pid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
        }
      }
    })();
    const stale = `.groups.json.${deadPid}.1.tmp`;
    const live = `.groups.json.${process.ppid}.1.tmp`;
    await writeFile(join(dir, stale), 'half');
    await writeFile(join(dir, live), 'in flight');
    await createFsGroupStore({ path }).apply({ added: [e('g', 'a')] });
    const left = await readdir(dir);
    expect(left).not.toContain(stale);
    expect(left).toContain(live);
  });
});
