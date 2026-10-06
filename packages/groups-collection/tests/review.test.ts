/**
 * Regression tests from the review of PR #7: a store write that commits then throws (B1), a revert
 * that would resurrect a deleted group (B2), embedded undo over a newer writer (S1), concurrent
 * record writes (S2), completing a half-failed rename (S3), the undo effect's collection (S5),
 * ordered groups (S6), sorted embedded fields (S7), code-declared vocabulary groups (S8), and an
 * idempotent store revert.
 */

import { describe, expect, it } from 'vitest';
import {
  compareOrder,
  createMemoryGroupStore,
  edgesOf,
  makeEdge,
  nodeId,
  type GroupStore,
} from '@zodal/groups-core';
import { createInMemoryProvider } from '@zodal/store';
import { defineTaggedCollection, INVERSE_EFFECT, type SpaceConfig, type TaggedCollection } from '../src/index.js';
import { flakyProvider, groupsOf, interceptStore, items, state, type Item } from './helpers.js';

const n = nodeId;
const members = (tc: TaggedCollection<Item>, group: string, space?: string) =>
  edgesOf(tc.space(space), n(group))
    .sort((x, y) => compareOrder(x.order, y.order))
    .map((e) => e.child as string);

describe('B1 — a store write that commits and then throws', () => {
  it('is recognized as applied: the record is kept, the edges are reported, the inverse undoes both', async () => {
    const inner = createMemoryGroupStore();
    const store = interceptStore(inner, (_call, delta, options) =>
      inner.apply(delta, options).then(() => Promise.reject(new Error('lock release failed'))),
    );
    const { provider } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: store } } });
    const start = await state(tc);
    const r = await tc.create({ id: 'z', title: 'Z' }, { groups: ['proj'] });
    expect(r.failed).toEqual([]);
    expect(r.succeeded).toEqual(['z']);
    expect(await provider.getOne('z')).toMatchObject({ id: 'z' });
    expect(groupsOf(tc, 'z')).toEqual(['proj']);
    // The store's later applies keep throwing after committing; the revert still lands.
    expect((await tc.revert(r.inverse)).failed).toEqual([]);
    expect(await state(tc)).toEqual(start);
  });

  it('when it cannot tell whether the write landed, the item is marked inconsistent', async () => {
    const inner = createMemoryGroupStore({ edges: [makeEdge(n('work'), n('a')), makeEdge(n('work'), n('b'))] });
    let other = 0;
    const store = interceptStore(inner, async (_call, delta, options) => {
      await inner.apply(delta, options);
      // Another writer lands before we can look, and our delta only removes edges: undecidable.
      await inner.apply({ added: [makeEdge(n('x'), n(`o${other++}`))] });
      throw new Error('connection reset');
    });
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: store } } });
    const r = await tc.untag(['a'], 'work');
    expect(r.failed[0]).toMatchObject({ id: 'a', code: 'storeWrite', inconsistent: true });
    expect(r.failed[0]!.reason).toMatch(/may have been applied/);
  });
});

const spaceKinds: Array<[string, () => SpaceConfig]> = [
  ['embedded', () => ({ edges: { embedded: 'tags' } })],
  ['GroupStore', () => ({ edges: createMemoryGroupStore() })],
];

describe('B2 — a revert never resurrects a group deleted after the operation', () => {
  for (const [name, space] of spaceKinds) {
    it(name, async () => {
      const { provider } = flakyProvider<Item>([
        { id: 'a', title: 'A', tags: [] },
        { id: 'b', title: 'B', tags: [] },
      ]);
      const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: space() } });
      await tc.tag(['a'], 'g1');
      await tc.tag(['a', 'b'], 'g2'); // b keeps g2 alive in an embedded space
      const del = await tc.deleteItem('a');
      expect((await tc.deleteGroup('g2')).ok).toBe(true);
      const undo = await tc.revert(del.inverse);
      expect(undo.failed).toMatchObject([{ id: 'a', code: 'conflict' }]);
      expect(undo.failed[0]!.reason).toMatch(/g2/);
      expect(tc.space().nodes.has(n('g2'))).toBe(false);
      await expect(provider.getOne('a')).rejects.toThrow(); // the item fails whole: no record either
    });
  }

  it('a group the inverse itself re-creates is fine', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: { embedded: 'tags' } } } });
    const start = await state(tc);
    const del = await tc.deleteGroup('work');
    expect((await tc.revert(del.inverse)).ok).toBe(true);
    expect(await state(tc)).toEqual(start);
  });
});

describe('S1 — embedded undo does not overwrite a newer writer', () => {
  it('refuses when the record no longer holds what the operation left, for the groups it touched', async () => {
    const { provider, inner } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const r = await tc.untag(['b'], 'urgent');
    await inner.update('b', { tags: ['work', 'urgent', 'x'] }); // someone re-tagged it
    const undo = await tc.revert(r.inverse);
    expect(undo.failed).toMatchObject([{ id: 'b', code: 'conflict' }]);
    expect((await provider.getOne('b')).tags).toEqual(['work', 'urgent', 'x']);
  });

  it('a change to another group of the same record does not block the undo', async () => {
    const { provider, inner } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const r = await tc.tag(['a'], 'g');
    await inner.update('a', { tags: ['work', 'g', 'h'] });
    const undo = await tc.revert(r.inverse);
    expect(undo.ok).toBe(true);
    expect((await provider.getOne('a')).tags).toEqual(['work', 'h']);
  });
});

describe('S2 — a concurrent record write that overwrites ours is detected', () => {
  it('re-reads after writing; an item whose field lost the change is failed and flagged', async () => {
    const { provider, afterUpdate } = flakyProvider(items());
    afterUpdate.set('a', (inner) => inner.update('a', { tags: ['other'] }));
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const r = await tc.tag(['a', 'c'], 'g');
    expect(r.succeeded).toEqual(['c']);
    expect(r.failed[0]).toMatchObject({ id: 'a', code: 'conflict', inconsistent: true });
    expect(r.inverse.items.map((i) => i.id)).toEqual(['c']);
    afterUpdate.clear();
    await tc.tag(['a'], 'h'); // the next operation sees the record as it really is
    expect(groupsOf(tc, 'a')).toEqual(['h', 'other']);
  });
});

describe('S3 — a half-failed embedded rename can be completed', () => {
  it('points to mergeGroups, which finishes it', async () => {
    const { provider, failing } = flakyProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    failing.update.add('b');
    const first = await tc.renameGroup('work', 'job');
    expect(first.succeeded).toEqual(['a']);
    failing.update.clear();
    const again = await tc.renameGroup('work', 'job');
    expect(again.failed[0]).toMatchObject({ code: 'groupExists' });
    expect(again.failed[0]!.reason).toMatch(/mergeGroups\('work', 'job'\)/);
    expect((await tc.mergeGroups('work', 'job')).ok).toBe(true);
    expect(tc.space().nodes.has(n('work'))).toBe(false);
    expect((await provider.getOne('b')).tags).toEqual(['job', 'urgent']);
  });
});

describe('S5 — the undo effect names its collection', () => {
  it('carries the command namespace', async () => {
    const tc = defineTaggedCollection<Item>({
      provider: createInMemoryProvider(items()),
      spaces: { tags: { edges: { embedded: 'tags' } } },
      commandNamespace: 'notes',
    });
    const r = await tc.commands.find((c) => c.id === 'notes.tag')!.execute({ ids: ['a'], group: 'g' });
    expect(r.ok && r.effects![0]).toMatchObject({ type: INVERSE_EFFECT, collection: 'notes' });
  });
});

describe('S6 — ordered groups', () => {
  const ordered = (): GroupStore => createMemoryGroupStore({ profile: 'polyhierarchy', overrides: { ordered: true } });

  it('tags append in order, `position` inserts, moveInGroup moves, and every step is undoable', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { list: { edges: ordered() } } });
    await tc.tag(['a', 'b', 'c'], 'todo');
    expect(members(tc, 'todo')).toEqual(['a', 'b', 'c']);
    await tc.tag(['d'], 'todo', { position: { before: 'b' } });
    expect(members(tc, 'todo')).toEqual(['a', 'd', 'b', 'c']);
    const before = await state(tc);
    const m = await tc.moveInGroup('c', 'todo', { after: 'a' });
    expect(m.ok).toBe(true);
    expect(members(tc, 'todo')).toEqual(['a', 'c', 'd', 'b']);
    const after = await state(tc);
    const undo = await tc.revert(m.inverse);
    expect(undo.failed).toEqual([]);
    expect(await state(tc)).toEqual(before); // the edge comes back with its old rank, same id
    expect((await tc.revert(undo.inverse)).failed).toEqual([]);
    expect(await state(tc)).toEqual(after);
    expect((await tc.moveInGroup('a', 'todo', { after: 'b' })).ok).toBe(true);
    expect(members(tc, 'todo')).toEqual(['c', 'd', 'b', 'a']);
  });

  it('a position relative to a non-member, or on an unordered or embedded space, is refused', async () => {
    const tc = defineTaggedCollection<Item>({
      provider: createInMemoryProvider(items()),
      spaces: { list: { edges: ordered() }, plain: { edges: createMemoryGroupStore() }, tags: { edges: { embedded: 'tags' } } },
    });
    await tc.tag(['a'], 'todo');
    expect((await tc.moveInGroup('a', 'todo', { after: 'zz' })).failed).toMatchObject([{ id: 'zz', code: 'notFound' }]);
    expect((await tc.moveInGroup('b', 'todo', { after: 'a' })).failed).toMatchObject([{ id: 'b', code: 'notFound' }]);
    await expect(tc.tag(['a'], 'g', { space: 'plain', position: { before: 'b' } })).rejects.toThrow(/not ordered/);
    await expect(tc.moveInGroup('a', 'work', { space: 'tags', after: 'b' })).rejects.toThrow(/not ordered|embedded/);
  });
});

describe('S7 — sorted embedded fields', () => {
  it("order: 'sorted' keeps the field sorted (binary order)", async () => {
    const provider = createInMemoryProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags', order: 'sorted' } } } });
    await tc.tag(['b'], 'alpha');
    expect((await provider.getOne('b')).tags).toEqual(['alpha', 'urgent', 'work']);
    await tc.create({ id: 'e', title: 'E' }, { groups: ['zeta', 'Beta', 'beta'] });
    expect((await provider.getOne('e')).tags).toEqual(['Beta', 'beta', 'zeta']);
    await tc.renameGroup('work', 'aaa');
    expect((await provider.getOne('b')).tags).toEqual(['aaa', 'alpha', 'urgent']);
  });
});

describe('S8 — code-declared vocabulary groups', () => {
  it('cannot be deleted, merged away or renamed (they would come back on load)', async () => {
    const tc = defineTaggedCollection<Item>({
      provider: createInMemoryProvider(items()),
      spaces: { tags: { edges: { embedded: 'tags' }, vocabulary: { nodes: [{ id: n('work'), label: 'Work' }] } } },
    });
    for (const r of [await tc.deleteGroup('work'), await tc.mergeGroups('work', 'urgent'), await tc.renameGroup('work', 'job')]) {
      expect(r.failed).toMatchObject([{ id: 'work', code: 'unsupported' }]);
      expect(r.failed[0]!.reason).toMatch(/vocabulary/);
    }
    expect(groupsOf(tc, 'a')).toEqual(['work']);
  });
});

describe('a store revert whose target state already holds', () => {
  it('is a success that changes nothing', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: createMemoryGroupStore() } } });
    await tc.tag(['a'], 'work');
    const untag = await tc.untag(['a'], 'work');
    await tc.tag(['a'], 'work'); // someone put it back
    const undo = await tc.revert(untag.inverse);
    expect(undo.failed).toEqual([]);
    expect(groupsOf(tc, 'a')).toEqual(['work']);
  });
});
