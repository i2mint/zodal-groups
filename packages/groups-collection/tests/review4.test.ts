/**
 * From the PR #8 (selection tagging) review: `bulkTag` can label the groups it creates, and
 * `untag` takes out memberships only — never an associative link such as `related`.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryGroupStore, edgeId, makeEdge, nodeId } from '@zodal/groups-core';
import { createInMemoryProvider } from '@zodal/store';
import { defineTaggedCollection } from '../src/index.js';
import { BACKINGS, state, type Item } from './helpers.js';

const seed = (): Item[] => [
  { id: 'a', title: 'Alpha', tags: ['work'] },
  { id: 'b', title: 'Beta', tags: [] },
];

for (const { name, make } of BACKINGS) {
  describe(`bulkTag labels — ${name}`, () => {
    it(name === 'embedded' ? 'an embedded field stores ids: a label other than the id is refused' : 'a created group gets its label, and the inverse removes it again', async () => {
      const backing = await make();
      try {
        const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(seed()), spaces: { tags: await backing.space({ seed: seed() }) } });
        await tc.load();
        if (name === 'embedded') {
          await expect(tc.bulkTag(['a'], { add: ['to-read'], labels: { 'to-read': 'To Read' } })).rejects.toThrow(/stores ids/);
          // A label equal to the id says nothing new: accepted.
          expect((await tc.bulkTag(['a'], { add: ['later'], labels: { later: 'later' } })).ok).toBe(true);
          return;
        }
        const start = await state(tc);
        const r = await tc.bulkTag(['a', 'b'], { add: ['to-read'], labels: { 'to-read': 'To Read' } });
        expect(r.failed).toEqual([]);
        expect(tc.space().nodes.get(nodeId('to-read'))?.label).toBe('To Read');
        const undo = await tc.revert(r.inverse);
        expect(undo.failed).toEqual([]);
        expect(await state(tc)).toEqual(start);
        expect(tc.space().nodes.has(nodeId('to-read'))).toBe(false);
      } finally {
        await backing.dispose();
      }
    });

    if (name !== 'embedded') {
      it('a label never renames a group that already exists', async () => {
        const backing = await make();
        try {
          const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(seed()), spaces: { tags: await backing.space({ seed: seed() }) } });
          await tc.load();
          const r = await tc.bulkTag(['b'], { add: ['work'], labels: { work: 'Renamed' } });
          expect(r.ok).toBe(true);
          expect(tc.space().nodes.get(nodeId('work'))?.label).toBeUndefined();
        } finally {
          await backing.dispose();
        }
      });
    }
  });
}

describe('untag takes out memberships only (review B7)', () => {
  it('a `related` link between the group and the item stays', async () => {
    const store = createMemoryGroupStore({
      profile: 'polyhierarchy',
      edges: [makeEdge(nodeId('work'), nodeId('a'), { id: edgeId('m') }), makeEdge(nodeId('work'), nodeId('b'), { id: edgeId('r'), kind: 'related' })],
    });
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(seed()), spaces: { tags: { edges: store } } });
    await tc.load();
    const r = await tc.untag(['a', 'b'], 'work');
    expect(r.ok).toBe(true);
    expect([...tc.space().edges.keys()]).toEqual(['r']); // the membership went, the link stayed
  });
});

describe('storesLabels: what a tagging menu needs to know about a space', () => {
  it('is false for an embedded space (it stores ids) and true for a GroupStore space', async () => {
    const tc = defineTaggedCollection<Item>({
      provider: createInMemoryProvider(seed()),
      spaces: { tags: { edges: { embedded: 'tags' } }, folders: { edges: createMemoryGroupStore({ profile: 'polyhierarchy' }) } },
    });
    expect(tc.storesLabels('tags')).toBe(false);
    expect(tc.storesLabels('folders')).toBe(true);
    expect(tc.storesLabels()).toBe(false); // the default space is the first: `tags`
    expect(() => tc.storesLabels('nope')).toThrow(/nope/);
  });
});
