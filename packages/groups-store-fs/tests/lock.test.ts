/**
 * The cross-process lock (`<manifest>.lock`): taken from read to rename, broken when stale (dead
 * pid, or too old), a clear error when a live writer holds it too long, always released.
 */

import { access, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { edgeId, makeEdge, nodeId } from '@zodal/groups-core';
import { createFsGroupStore, ManifestLockError, nodeManifestIO, type ManifestIO } from '../src/index.js';

const e = (parent: string, child: string) => makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`${parent}>${child}`) });
const exists = (p: string) => access(p).then(() => true, () => false);

let dir: string;
let path: string;
let lock: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'groups-store-fs-lock-'));
  path = join(dir, 'groups.json');
  lock = `${path}.lock`;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  for (let pid = 4_000_000; ; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
}

describe('the manifest lock', () => {
  it('is released after a write, and after a failed write', async () => {
    const real = nodeManifestIO();
    let fail = false;
    const io: ManifestIO = { ...real, write: async (p, t, o) => (fail ? Promise.reject(new Error('disk full')) : real.write(p, t, o)) };
    const store = createFsGroupStore({ path, io });
    expect((await store.apply({ added: [e('g', 'a')] })).ok).toBe(true);
    expect(await exists(lock)).toBe(false);
    fail = true;
    await expect(store.apply({ added: [e('g', 'b')] })).rejects.toThrow('disk full');
    expect(await exists(lock)).toBe(false);
  });

  it("breaks a dead process's lock", async () => {
    await writeFile(lock, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
    expect((await createFsGroupStore({ path }).apply({ added: [e('g', 'a')] })).ok).toBe(true);
    expect(await exists(lock)).toBe(false);
    expect((await readdir(dir)).filter((n) => n.includes('.stale.'))).toEqual([]);
  });

  it('waits for a live holder, then fails clearly — leaving its lock alone', async () => {
    const theirs = JSON.stringify({ pid: process.ppid, at: Date.now() });
    await writeFile(lock, theirs);
    const store = createFsGroupStore({ path, lockTimeoutMs: 150 });
    const attempt = store.apply({ added: [e('g', 'a')] });
    await expect(attempt).rejects.toBeInstanceOf(ManifestLockError);
    await expect(store.apply({ added: [e('g', 'a')] })).rejects.toThrow(new RegExp(`held by pid ${process.ppid}`));
    expect(await exists(path)).toBe(false); // nothing written
    expect(await exists(lock)).toBe(true);
  });

  it('proceeds as soon as a live holder releases', async () => {
    await writeFile(lock, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    setTimeout(() => void rm(lock, { force: true }), 60);
    expect((await createFsGroupStore({ path, lockTimeoutMs: 5_000 }).apply({ added: [e('g', 'a')] })).ok).toBe(true);
  });

  it('breaks a lock older than staleLockMs even if its holder is alive (it hung)', async () => {
    await writeFile(lock, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 }));
    expect((await createFsGroupStore({ path, staleLockMs: 1_000 }).apply({ added: [e('g', 'a')] })).ok).toBe(true);
  });

  it('judges an unreadable lock file by its age', async () => {
    await writeFile(lock, 'garbage');
    await expect(createFsGroupStore({ path, lockTimeoutMs: 100 }).apply({ added: [e('g', 'a')] })).rejects.toThrow(/unreadable lock/);
    const past = new Date(Date.now() - 120_000);
    await utimes(lock, past, past);
    expect((await createFsGroupStore({ path, staleLockMs: 1_000 }).apply({ added: [e('g', 'a')] })).ok).toBe(true);
  });

  it('does not block reads', async () => {
    await createFsGroupStore({ path }).apply({ added: [e('g', 'a')] });
    await writeFile(lock, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    expect((await createFsGroupStore({ path, lockTimeoutMs: 50 }).load()).edges.size).toBe(1);
  });
});
