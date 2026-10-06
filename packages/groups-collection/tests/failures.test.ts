/**
 * Failure semantics (issue #1, Revision): per item, the record write and its edges succeed together
 * or are compensated; a bulk operation keeps what succeeded, reports `{ succeeded, failed }`, and
 * returns one inverse that undoes exactly the applied part.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryGroupStore, makeEdge, nodeId, toSnapshot } from '@zodal/groups-core';
import { defineTaggedCollection } from '../src/index.js';
import { flakyProvider, groupsOf, interceptStore, items, state, type Item } from './helpers.js';

const embeddedTags = { tags: { edges: { embedded: 'tags' } } } as const;

describe('a record write failing mid-bulk (embedded)', () => {
  it('drops that item only; the others are applied; the inverse undoes exactly the applied part', async () => {
    const { provider, failing } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: embeddedTags });
    const start = await state(tc);
    failing.update.add('b');

    const r = await tc.tag(['a', 'b', 'c'], 'later');
    expect(r.ok).toBe(false);
    expect(r.succeeded).toEqual(['a', 'c']);
    expect(r.failed).toMatchObject([{ id: 'b', code: 'recordWrite' }]);
    expect(r.failed[0]!.reason).toMatch(/disk full/);
    // b: record and edges agree, both untouched
    expect((await provider.getOne('b')).tags).toEqual(['work', 'urgent']);
    expect(groupsOf(tc, 'b')).toEqual(['urgent', 'work']);
    // a and c: applied
    expect(groupsOf(tc, 'a')).toEqual(['later', 'work']);
    expect((await provider.getOne('c')).tags).toEqual(['later']);
    expect(r.inverse.items.map((i) => i.id)).toEqual(['a', 'c']);

    failing.update.clear();
    const undo = await tc.revert(r.inverse);
    expect(undo.ok).toBe(true);
    expect(await state(tc)).toEqual(start);
  });

  it('a group-level operation keeps the group while a member could not be moved', async () => {
    const { provider, failing } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: embeddedTags });
    const start = await state(tc);
    failing.update.add('b');

    const r = await tc.deleteGroup('work');
    expect(r.succeeded).toEqual(['a']);
    expect(r.failed).toMatchObject([{ id: 'b', code: 'recordWrite' }]);
    expect(groupsOf(tc, 'a')).toEqual([]);
    expect(groupsOf(tc, 'b')).toEqual(['urgent', 'work']);
    expect(tc.space().nodes.has(nodeId('work'))).toBe(true); // still holds b

    failing.update.clear();
    expect((await tc.revert(r.inverse)).ok).toBe(true);
    expect(await state(tc)).toEqual(start);

    // Retrying once the provider recovers completes it.
    const again = await tc.deleteGroup('work');
    expect(again.ok).toBe(true);
    expect(again.succeeded).toEqual(['a', 'b', 'work']); // the revert put a back in work
    expect(tc.space().nodes.has(nodeId('work'))).toBe(false);
  });

  it('a revert keeps the same semantics: an item whose record cannot be written stays as it is', async () => {
    const { provider, failing } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: embeddedTags });
    const r = await tc.tag(['a', 'c'], 'urgent');
    failing.update.add('a');
    const undo = await tc.revert(r.inverse);
    expect(undo.succeeded).toEqual(['c']);
    expect(undo.failed).toMatchObject([{ id: 'a', code: 'recordWrite' }]);
    expect(groupsOf(tc, 'a')).toEqual(['urgent', 'work']);
    expect(groupsOf(tc, 'c')).toEqual([]);
  });
});

describe('GroupStore spaces: compensation', () => {
  it('a record write that fails writes no edge', async () => {
    const { provider, failing } = flakyProvider(items());
    const store = interceptStore(createMemoryGroupStore());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: store } } });
    await tc.load();
    failing.create.add('e');
    const r = await tc.create({ id: 'e', title: 'E' }, { groups: ['x'] });
    expect(r.failed).toMatchObject([{ id: 'e', code: 'recordWrite' }]);
    expect(store.applies).toBe(0);
  });

  it('a store write that fails after the record was created deletes the record again', async () => {
    const { provider, calls } = flakyProvider(items());
    const store = interceptStore(createMemoryGroupStore(), () => Promise.reject(new Error('EIO: disk unplugged')));
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: store } } });
    const r = await tc.create({ id: 'e', title: 'E' }, { groups: ['x'] });
    expect(r.failed).toMatchObject([{ id: 'e', code: 'storeWrite' }]);
    expect(r.failed[0]!.reason).toMatch(/disk unplugged/);
    expect(r.failed[0]!.inconsistent).toBeUndefined();
    expect(calls.create).toEqual(['e']);
    expect(calls.delete).toEqual(['e']);
    await expect(provider.getOne('e')).rejects.toThrow();
    expect(r.inverse.items).toEqual([]);
  });

  it('several spaces: when the second store refuses, the first store write and the record are undone', async () => {
    const { provider } = flakyProvider(items());
    const tagsStore = createMemoryGroupStore();
    const before = toSnapshot(await tagsStore.load());
    const folders = interceptStore(createMemoryGroupStore(), () => Promise.reject(new Error('EACCES')));
    const tc = defineTaggedCollection<Item>({
      provider,
      spaces: { tags: { edges: tagsStore }, folders: { edges: folders } },
    });
    const r = await tc.create({ id: 'e', title: 'E' }, { groups: { tags: ['new'], folders: ['inbox'] } });
    expect(r.failed).toMatchObject([{ id: 'e', code: 'storeWrite' }]);
    await expect(provider.getOne('e')).rejects.toThrow();
    const after = toSnapshot(await tagsStore.load());
    expect({ nodes: after.nodes, edges: after.edges }).toEqual({ nodes: before.nodes, edges: before.edges });
  });

  it('when the compensation fails too, the failure says the item is inconsistent and why', async () => {
    const { provider, failing } = flakyProvider(items());
    const store = interceptStore(createMemoryGroupStore(), () => Promise.reject(new Error('EIO')));
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: store } } });
    failing.delete.add('e');
    const r = await tc.create({ id: 'e', title: 'E' }, { groups: ['x'] });
    expect(r.failed[0]).toMatchObject({ id: 'e', code: 'storeWrite', inconsistent: true });
    expect(r.failed[0]!.reason).toMatch(/record could not be restored/);
  });

  it('deleteItem: a store write that fails re-creates the deleted record', async () => {
    const { provider } = flakyProvider(items());
    const inner = createMemoryGroupStore({ edges: [makeEdge(nodeId('work'), nodeId('a'))] });
    let broken = false;
    const store = interceptStore(inner, () => (broken ? Promise.reject(new Error('EIO')) : undefined));
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: store } } });
    await tc.load();
    broken = true;
    const r = await tc.deleteItem('a');
    expect(r.failed).toMatchObject([{ id: 'a', code: 'storeWrite' }]);
    expect(await provider.getOne('a')).toMatchObject({ id: 'a', title: 'Alpha' });
    expect(groupsOf(tc, 'a')).toEqual(['work']);
  });
});

describe('reverts out of order', () => {
  for (const [name, space] of [
    ['embedded', () => ({ edges: { embedded: 'tags' } })],
    ['GroupStore', () => ({ edges: createMemoryGroupStore() })],
  ] as const) {
    it(`undoing a create removes every membership the record has now, not only those it was created with — ${name}`, async () => {
      const { provider } = flakyProvider(items());
      const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: space() } });
      const created = await tc.create({ id: 'e', title: 'E' }, { groups: ['new'] });
      await tc.tag(['e', 'a'], 'later');
      const undo = await tc.revert(created.inverse);
      expect(undo.ok).toBe(true);
      await expect(provider.getOne('e')).rejects.toThrow();
      expect(tc.space().nodes.has(nodeId('e'))).toBe(false);
      expect(groupsOf(tc, 'e')).toEqual([]);
      expect(groupsOf(tc, 'a')).toContain('later'); // another item's membership is not the create's to undo
      // …and the redo brings back exactly what the undo removed.
      const before = await state(tc);
      const redo = await tc.revert(undo.inverse);
      expect(redo.ok).toBe(true);
      expect(groupsOf(tc, 'e')).toEqual(['later', 'new']);
      expect((await tc.revert(redo.inverse)).ok).toBe(true);
      expect(await state(tc)).toEqual(before);
    });
  }

  it('a failed create without an id reports the id as empty, not an internal stand-in', async () => {
    const { provider } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { profile: 'filesystem', edges: { embedded: 'tags' } } } });
    const r = await tc.create({ title: 'no id' } as Item, { groups: ['x', 'y'] });
    expect(r.failed).toMatchObject([{ id: '', code: 'violation' }]);
  });
});
