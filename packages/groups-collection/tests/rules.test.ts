/**
 * Profile rules, family cardinality and acyclicity are checked BEFORE any record is written — the
 * dry run is a pure `applyDelta` on the current space. A violation that belongs to one item fails
 * that item; one that belongs to no item (a group-level rule) refuses the operation.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryGroupStore, EXCLUSIVE, makeEdge, nodeId } from '@zodal/groups-core';
import { defineTaggedCollection, type SpaceConfig } from '../src/index.js';
import { flakyProvider, groupsOf, type Item } from './helpers.js';

const n = nodeId;
const statusVocabulary = {
  nodes: [{ id: n('status'), family: EXCLUSIVE }],
  edges: [makeEdge(n('status'), n('todo'), { id: 'v:todo' as never }), makeEdge(n('status'), n('done'), { id: 'v:done' as never })],
};
const seed = (): Item[] => [
  { id: 'a', title: 'A', status: ['todo'] },
  { id: 'c', title: 'C', status: [] },
];

const backings: Array<[string, () => SpaceConfig]> = [
  ['embedded, with a vocabulary', () => ({ edges: { embedded: 'status' }, vocabulary: statusVocabulary })],
  [
    'GroupStore',
    () => ({
      edges: createMemoryGroupStore({ nodes: statusVocabulary.nodes, edges: [...statusVocabulary.edges, makeEdge(n('todo'), n('a'))] }),
    }),
  ],
];

for (const [name, space] of backings) {
  describe(`family cardinality — ${name}`, () => {
    it('tag: the item that would break the exclusive family fails, before its record is written', async () => {
      const { provider, calls } = flakyProvider(seed());
      const tc = defineTaggedCollection<Item>({ provider, spaces: { status: space() } });
      const r = await tc.tag(['a', 'c'], 'done');
      expect(r.succeeded).toEqual(['c']);
      expect(r.failed).toMatchObject([{ id: 'a', code: 'violation' }]);
      expect(r.failed[0]!.violations![0]).toMatchObject({ code: 'maxPerFamily', family: 'status', node: 'a' });
      expect(calls.update).not.toContain('a');
      expect(groupsOf(tc, 'a')).toEqual(['todo']);
    });

    it('create: refused before the record is created', async () => {
      const { provider, calls } = flakyProvider(seed());
      const tc = defineTaggedCollection<Item>({ provider, spaces: { status: space() } });
      const r = await tc.create({ id: 'e', title: 'E' }, { groups: ['todo', 'done'] });
      expect(r.failed).toMatchObject([{ code: 'violation' }]);
      expect(r.failed[0]!.violations![0]!.code).toBe('maxPerFamily');
      expect(calls.create).toEqual([]);
      await expect(provider.getOne('e')).rejects.toThrow();
    });
  });
}

describe('profile caps, per item', () => {
  it('maxGroupsPerItem fails the item at its cap; the others are tagged', async () => {
    const { provider, calls } = flakyProvider<Item>([
      { id: 'a', title: 'A', tags: ['x'] },
      { id: 'b', title: 'B', tags: ['x', 'y'] },
    ]);
    const tc = defineTaggedCollection<Item>({
      provider,
      spaces: { tags: { profile: 'flatTags', overrides: { maxGroupsPerItem: 2 }, edges: { embedded: 'tags' } } },
    });
    const r = await tc.tag(['a', 'b'], 'z');
    expect(r.succeeded).toEqual(['a']);
    expect(r.failed).toMatchObject([{ id: 'b', code: 'violation' }]);
    expect(r.failed[0]!.violations![0]!.code).toBe('maxGroupsPerItem');
    expect(calls.update).toEqual(['a']);
  });

  it('a group-level violation refuses the whole operation, writing nothing', async () => {
    // Under flatTags a tag cannot be tagged. `b` is tagged with `x`; making `b` a tag (tagging
    // items with it) would nest it inside `x` — a rule about `b`, not about any one item.
    const { provider, calls } = flakyProvider<Item>([
      { id: 'a', title: 'A', tags: [] },
      { id: 'b', title: 'B', tags: ['x'] },
      { id: 'c', title: 'C', tags: [] },
    ]);
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { profile: 'flatTags', edges: { embedded: 'tags' } } } });
    const r = await tc.tag(['a', 'c'], 'b');
    expect(r.succeeded).toEqual([]);
    expect(r.failed.map((f) => f.id)).toEqual(['a', 'c']);
    expect(r.failed[0]!.violations![0]!.code).toBe('groupsMayContainGroups');
    expect(calls.update).toEqual([]);
  });

  it('a cycle is refused with its path, for that item only', async () => {
    const { provider, calls } = flakyProvider<Item>([
      { id: 'a', title: 'A', tags: ['b'] }, // a is in b
      { id: 'b', title: 'B', tags: [] },
      { id: 'c', title: 'C', tags: [] },
    ]);
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const r = await tc.tag(['b', 'c'], 'a'); // b in a would close a → b → a
    expect(r.succeeded).toEqual(['c']);
    expect(r.failed[0]).toMatchObject({ id: 'b', code: 'violation' });
    expect(r.failed[0]!.violations![0]).toMatchObject({ code: 'cycle', path: ['b', 'a'] });
    expect(calls.update).toEqual(['c']);
  });

  it('a record-group of an embedded space cannot be deleted or merged as a group', async () => {
    const { provider } = flakyProvider<Item>([
      { id: 'a', title: 'A', tags: ['b'] },
      { id: 'b', title: 'B', tags: [] },
    ]);
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    expect((await tc.deleteGroup('b')).failed).toMatchObject([{ id: 'b', code: 'unsupported' }]);
    expect((await tc.mergeGroups('b', 'z')).failed).toMatchObject([{ id: 'b', code: 'unsupported' }]);
    expect(groupsOf(tc, 'a')).toEqual(['b']);
  });
});
