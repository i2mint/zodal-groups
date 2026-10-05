/**
 * What is specific to the filesystem: the manifest format, atomic writes, the parent directory,
 * serialization across instances, and corrupt manifests (an error — never an empty space).
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteNodeDelta, edgeId, invert, makeEdge, nodeId } from '@zodal/groups-core';
import {
  createFsGroupStore,
  ManifestError,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  nodeManifestIO,
  type ManifestIO,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string) => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}`) });

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'groups-store-fs-'));
  path = join(dir, 'groups.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the manifest', () => {
  it('is a diffable JSON file with a format marker, a version and a revision', async () => {
    const store = createFsGroupStore({ path });
    await store.apply({ added: [e('work', 'msg-1')], upsertNodes: [{ id: n('work'), label: 'Work' }] });
    const text = await readFile(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "format"'); // indented
    const json = JSON.parse(text);
    expect(json).toMatchObject({ format: MANIFEST_FORMAT, version: MANIFEST_VERSION, revision: 1 });
    expect(json.nodes).toEqual([{ id: 'work', label: 'Work' }, { id: 'msg-1' }]);
    expect(json.edges).toEqual([{ id: 'work>msg-1', parent: 'work', child: 'msg-1', kind: 'contains' }]);
  });

  it('a missing manifest is an empty space, and nothing is written until the first apply', async () => {
    const store = createFsGroupStore({ path: join(dir, 'a', 'b', 'groups.json') });
    expect((await store.load()).edges.size).toBe(0);
    expect(await readdir(dir)).toEqual([]);
    await store.apply({ added: [e('g', 'i')] });
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['groups.json']);
  });

  it('leaves no temp file behind', async () => {
    const store = createFsGroupStore({ path });
    for (let i = 0; i < 5; i++) await store.apply({ added: [e('g', `i${i}`)] });
    expect(await readdir(dir)).toEqual(['groups.json']);
  });

  it('honours the indent option', async () => {
    await createFsGroupStore({ path, indent: 0 }).apply({ added: [e('g', 'i')] });
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('keeps a tombstoned group restorable across processes (a fresh instance)', async () => {
    const store = createFsGroupStore({ path });
    await store.apply({ upsertNodes: [{ id: n('work'), label: 'Work', payload: { colour: 'red' } }], added: [e('work', 'a')] });
    const before = await store.load();
    const del = deleteNodeDelta(before, n('work'));
    await store.apply(del);
    const later = createFsGroupStore({ path });
    expect((await later.apply(invert(before, del))).ok).toBe(true);
    expect((await later.load()).nodes.get(n('work'))).toEqual({ id: 'work', label: 'Work', payload: { colour: 'red' } });
  });
});

describe('a corrupt manifest is an error, never an empty space', () => {
  const corrupt: [string, string, RegExp][] = [
    ['invalid JSON', '{"format": ', /not valid JSON/],
    ['an empty file', '   \n', /is empty/],
    ['not a manifest', JSON.stringify({ nodes: [], edges: [] }), /not a zodal-groups manifest/],
    ['a newer format version', JSON.stringify({ format: MANIFEST_FORMAT, version: MANIFEST_VERSION + 1, nodes: [], edges: [] }), /newer/],
    ['a bad version', JSON.stringify({ format: MANIFEST_FORMAT, version: 'one', nodes: [], edges: [] }), /"version"/],
    [
      'a malformed edge',
      JSON.stringify({ format: MANIFEST_FORMAT, version: 1, nodes: [], edges: [{ id: 'x', child: 'c', kind: 'contains' }] }),
      /edges\[0\]\.parent/,
    ],
  ];
  for (const [what, text, message] of corrupt) {
    it(`${what}: load and apply reject with a ManifestError, and the file is untouched`, async () => {
      await writeFile(path, text);
      const store = createFsGroupStore({ path });
      const loading = store.load();
      await expect(loading).rejects.toBeInstanceOf(ManifestError);
      await expect(loading).rejects.toThrow(message);
      await expect(store.apply({ added: [e('g', 'i')] })).rejects.toThrow(path);
      expect(await readFile(path, 'utf8')).toBe(text);
    });
  }

  it('the store keeps working once the manifest is repaired', async () => {
    await writeFile(path, 'garbage');
    const store = createFsGroupStore({ path });
    await expect(store.load()).rejects.toBeInstanceOf(ManifestError);
    await rm(path);
    expect((await store.apply({ added: [e('g', 'i')] })).ok).toBe(true);
  });
});

describe('profile violations in stored data', () => {
  it('load does not enforce the profile (read path); writes still do', async () => {
    // A manifest a person edited: an item in two folders, which `filesystem` forbids.
    await writeFile(
      path,
      JSON.stringify({ format: MANIFEST_FORMAT, version: 1, nodes: [], edges: [e('a', 'x'), e('b', 'x')] }),
    );
    const store = createFsGroupStore({ path, profile: 'filesystem' });
    expect((await store.load()).edges.size).toBe(2);
    const r = await store.apply({ added: [e('c', 'y'), e('d', 'y')] });
    expect(r.ok).toBe(false);
  });
});

describe('writes', () => {
  it('a failed write rejects, and leaves the manifest as it was', async () => {
    const real = nodeManifestIO();
    let failNext = false;
    const io: ManifestIO = {
      read: real.read,
      write: async (p, text) => {
        if (failNext) throw new Error('disk full');
        return real.write(p, text);
      },
    };
    const store = createFsGroupStore({ path, io });
    await store.apply({ added: [e('g', 'i')] });
    const before = await readFile(path, 'utf8');
    failNext = true;
    await expect(store.apply({ added: [e('g', 'j')] })).rejects.toThrow('disk full');
    expect(await readFile(path, 'utf8')).toBe(before);
    failNext = false;
    expect((await store.apply({ added: [e('g', 'k')] })).ok).toBe(true); // the queue is not poisoned
    expect([...(await store.load()).edges.keys()].sort()).toEqual(['g>i', 'g>k']);
  });

  it('concurrent applies through two instances on one manifest are all kept', async () => {
    const a = createFsGroupStore({ path });
    const b = createFsGroupStore({ path });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).apply({ added: [e('bucket', `item-${i}`)] })),
    );
    const space = await a.load();
    expect(space.edges.size).toBe(20);
    expect(space.revision).toBe(20);
  });

  it('sees an edit made to the manifest between operations', async () => {
    const store = createFsGroupStore({ path });
    await store.apply({ added: [e('g', 'i')] });
    const json = JSON.parse(await readFile(path, 'utf8'));
    json.nodes.push({ id: 'hand-made', label: 'By hand' });
    await writeFile(path, JSON.stringify(json));
    expect((await store.load()).nodes.get(n('hand-made'))).toEqual({ id: 'hand-made', label: 'By hand' });
  });

  it('creates the parent directory when it is missing', async () => {
    const deep = join(dir, 'x', 'y', 'z', 'groups.json');
    await createFsGroupStore({ path: deep }).apply({ added: [e('g', 'i')] });
    expect(JSON.parse(await readFile(deep, 'utf8')).edges).toHaveLength(1);
  });

  it('notifies subscribers only after the manifest is written', async () => {
    const store = createFsGroupStore({ path });
    const seen: string[] = [];
    store.subscribe!(() => {
      void readFile(path, 'utf8').then((t) => seen.push(t));
    });
    await store.apply({ added: [e('g', 'i')] });
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(seen[0]!).edges).toHaveLength(1);
  });
});

