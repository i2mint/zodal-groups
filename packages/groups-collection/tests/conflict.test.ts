/**
 * Two writers on one GroupStore: every write carries `expectedRevision` (and the epoch once known),
 * a `conflict` reloads, rebuilds from the operation's intent, re-validates and retries — a bounded
 * number of times — and an item the fresh state refuses fails alone.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryGroupStore, EXCLUSIVE, makeEdge, nodeId, type GroupStore } from '@zodal/groups-core';
import { createFsGroupStore } from '@zodal/groups-store-fs';
import { createInMemoryProvider } from '@zodal/store';
import { defineTaggedCollection } from '../src/index.js';
import { flakyProvider, interceptStore, items, type Item } from './helpers.js';

const n = nodeId;
const members = async (store: GroupStore, group: string) => {
  const s = await store.load();
  return [...(s.forward.get(n(group)) ?? [])].map((e) => s.edges.get(e)!.child as string).sort();
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'groups-collection-conflict-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const twoWriters: Array<[string, () => [GroupStore, GroupStore]]> = [
  [
    'memory store (one instance, two collections)',
    () => {
      const s = createMemoryGroupStore();
      return [s, s];
    },
  ],
  [
    'fs store (two instances on one manifest)',
    () => [createFsGroupStore({ path: join(dir, 'g.json') }), createFsGroupStore({ path: join(dir, 'g.json') })],
  ],
];

for (const [name, open] of twoWriters) {
  describe(`two writers — ${name}`, () => {
    it('the second writer conflicts, reloads, rebuilds and lands; nothing is lost', async () => {
      const [s1, s2] = open();
      const w1 = interceptStore(s1);
      const w2 = interceptStore(s2);
      const provider = createInMemoryProvider(items());
      const tc1 = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: w1 } } });
      const tc2 = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: w2 } } });
      await tc1.load();
      await tc2.load(); // both see revision 0

      expect((await tc1.tag(['a'], 'x')).ok).toBe(true);
      const r2 = await tc2.tag(['b'], 'x'); // built against revision 0: conflict, then retried
      expect(r2.ok).toBe(true);
      expect(w2.applies).toBe(2);
      expect(await members(s1, 'x')).toEqual(['a', 'b']);

      // Its inverse undoes only its own write, even though another writer wrote before it.
      expect((await tc2.revert(r2.inverse)).ok).toBe(true);
      expect(await members(s1, 'x')).toEqual(['a']);
    });

    it('concurrent operations from both writers all land', async () => {
      const [s1, s2] = open();
      const provider = createInMemoryProvider(items());
      const tc1 = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: s1 } }, maxRetries: 20 });
      const tc2 = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: s2 } }, maxRetries: 20 });
      const groups = Array.from({ length: 8 }, (_, i) => `g${i}`);
      const results = await Promise.all(groups.map((g, i) => (i % 2 ? tc1 : tc2).tag(['a', 'b'], g)));
      for (const r of results) expect(r.failed).toEqual([]);
      for (const g of groups) expect(await members(s1, g)).toEqual(['a', 'b']);
    });
  });
}

describe('a conflict that turns into a violation', () => {
  it('re-validates on the fresh state: the item the other writer made invalid fails alone', async () => {
    // Status is an exclusive family: an item is in at most one of todo / done.
    const store = createMemoryGroupStore({
      nodes: [{ id: n('status'), family: EXCLUSIVE }],
      edges: [makeEdge(n('status'), n('todo')), makeEdge(n('status'), n('done'))],
    });
    const provider = createInMemoryProvider(items());
    const tc1 = defineTaggedCollection<Item>({ provider, spaces: { status: { edges: store } } });
    const tc2 = defineTaggedCollection<Item>({ provider, spaces: { status: { edges: store } } });
    await tc1.load();
    await tc2.load();

    await tc1.tag(['a'], 'todo');
    const r = await tc2.tag(['a', 'b'], 'done'); // valid against its stale view; not after the reload
    expect(r.succeeded).toEqual(['b']);
    expect(r.failed).toMatchObject([{ id: 'a', code: 'violation' }]);
    expect(r.failed[0]!.violations?.[0]?.code).toBe('maxPerFamily');
    expect(await members(store, 'done')).toEqual(['b']);
    expect(await members(store, 'todo')).toEqual(['a']);
  });
});

describe('a refusal from a stale view', () => {
  it('is re-checked against the store before it is reported', async () => {
    const store = createMemoryGroupStore({
      nodes: [{ id: n('status'), family: EXCLUSIVE }],
      edges: [makeEdge(n('status'), n('todo')), makeEdge(n('status'), n('done')), makeEdge(n('todo'), n('a'))],
    });
    const provider = createInMemoryProvider(items());
    const tc1 = defineTaggedCollection<Item>({ provider, spaces: { status: { edges: store } } });
    const tc2 = defineTaggedCollection<Item>({ provider, spaces: { status: { edges: store } } });
    await tc1.load();
    await tc2.load(); // tc2 sees a in todo
    await tc1.untag(['a'], 'todo'); // …which is no longer true
    const r = await tc2.tag(['a'], 'done');
    expect(r.ok).toBe(true);
    expect(await members(store, 'done')).toEqual(['a']);
  });
});

describe('retries are bounded', () => {
  it('a store that keeps conflicting fails the operation after maxRetries, and the record write is undone', async () => {
    const inner = createMemoryGroupStore();
    const always = interceptStore(inner, async () => ({
      ok: false,
      violations: [{ code: 'conflict', message: 'someone else got there first', expectedRevision: 0, actualRevision: 1 }],
    }));
    const { provider, calls } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: always } }, maxRetries: 2 });
    const r = await tc.create({ id: 'e', title: 'E' }, { groups: ['x'] });
    expect(always.applies).toBe(3); // the write + 2 retries
    expect(r.failed).toMatchObject([{ id: 'e', code: 'conflict' }]);
    expect(calls.delete).toEqual(['e']);
    await expect(provider.getOne('e')).rejects.toThrow();
  });

  it('the epoch is passed once known, so a re-created backing is a conflict, not a silent overwrite', async () => {
    const seen: Array<{ expectedRevision?: number; expectedEpoch?: string } | undefined> = [];
    const store = interceptStore(createMemoryGroupStore(), (_call, _delta, options) => {
      seen.push(options);
      return undefined;
    });
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: store } } });
    await tc.tag(['a'], 'x');
    await tc.tag(['b'], 'x');
    expect(seen[0]).toEqual({ expectedRevision: 0 });
    expect(seen[1]).toMatchObject({ expectedRevision: 1, expectedEpoch: expect.any(String) });
  });
});
