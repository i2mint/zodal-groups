/**
 * Regression tests from the second review of PR #7 (the reviewer's zz-attack probes, made to
 * assert): deciding whether a throwing store write landed (N1), ties after merging ordered groups
 * (N2), reverting a move over a newer change (N3), unranked members (N5), and the message for an
 * embedded group that was only emptied (N6).
 */

import { describe, expect, it } from 'vitest';
import { compareOrder, createMemoryGroupStore, edgesOf, nodeId, type GroupStore } from '@zodal/groups-core';
import { createInMemoryProvider } from '@zodal/store';
import { defineTaggedCollection, type TaggedCollection } from '../src/index.js';
import { interceptStore, items, type Item } from './helpers.js';

const n = nodeId;
const ordered = (): GroupStore => createMemoryGroupStore({ profile: 'polyhierarchy', overrides: { ordered: true } });
const members = (tc: TaggedCollection<Item>, g: string, space?: string) =>
  edgesOf(tc.space(space), n(g))
    .sort((x, y) => compareOrder(x.order, y.order))
    .map((e) => e.child as string);
const ranks = (tc: TaggedCollection<Item>, g: string) => edgesOf(tc.space(), n(g)).map((e) => e.order);

/** A store whose next apply does NOT apply ours: another writer commits once, then it throws. */
function throwsAfterOther(inner: GroupStore, other: (delta: Parameters<GroupStore['apply']>[0]) => Parameters<GroupStore['apply']>[0]) {
  let armed = false;
  const store = interceptStore(inner, (_c, delta) => {
    if (!armed) return undefined;
    armed = false;
    return inner.apply(other(delta)).then(() => Promise.reject(new Error('timeout')));
  });
  return { store, arm: () => (armed = true) };
}

/** A store whose next apply applies ours, then throws (nobody else writes). */
function appliesThenThrows(inner: GroupStore) {
  let armed = false;
  const store = interceptStore(inner, (_c, delta, options) => {
    if (!armed) return undefined;
    armed = false;
    return inner.apply(delta, options).then(() => Promise.reject(new Error('lock release failed')));
  });
  return { store, arm: () => (armed = true) };
}

describe('N1 — a throwing store write is reported succeeded only on evidence it is ours', () => {
  it('label rename not applied, another writer committed once → failed, inconsistent', async () => {
    const inner = createMemoryGroupStore();
    const { store, arm } = throwsAfterOther(inner, () => ({ added: [{ id: 'o' as never, parent: n('zz'), child: n('c'), kind: 'contains' }] }));
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { col: { edges: store } } });
    await tc.tag(['a'], 'g');
    arm();
    const r = await tc.renameGroup('g', 'Shiny', { by: 'label' });
    expect(r.ok).toBe(false);
    expect(r.failed[0]).toMatchObject({ code: 'storeWrite', inconsistent: true });
    expect((await inner.load()).nodes.get(n('g'))?.label).toBeUndefined();
  });

  it('moveInGroup not applied, another writer committed once → failed, inconsistent', async () => {
    const inner = ordered();
    const { store, arm } = throwsAfterOther(inner, () => ({ added: [{ id: 'o' as never, parent: n('zz'), child: n('d'), kind: 'contains', order: 'a0' }] }));
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { list: { edges: store } } });
    await tc.tag(['a', 'b', 'c'], 'todo');
    arm();
    const r = await tc.moveInGroup('c', 'todo', { before: 'a' });
    expect(r.succeeded).toEqual([]);
    expect(r.failed[0]).toMatchObject({ id: 'c', code: 'storeWrite', inconsistent: true });
  });

  it('remove-only delta, the other writer removed the same edge → failed, inconsistent', async () => {
    const inner = createMemoryGroupStore();
    const { store, arm } = throwsAfterOther(inner, (d) => ({ removed: d.removed }));
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { col: { edges: store } } });
    await tc.tag(['a'], 'g');
    arm();
    const r = await tc.untag(['a'], 'g');
    expect(r.failed[0]).toMatchObject({ id: 'a', code: 'storeWrite', inconsistent: true });
    expect(r.inverse.items).toEqual([]);
  });

  it('adds with fresh ids, not applied, one other write → decidably not applied (failed, consistent)', async () => {
    const inner = createMemoryGroupStore();
    const { store, arm } = throwsAfterOther(inner, () => ({ added: [{ id: 'o' as never, parent: n('h'), child: n('c'), kind: 'contains' }] }));
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { col: { edges: store } } });
    arm();
    const r = await tc.tag(['a'], 'g');
    expect(r.failed[0]).toMatchObject({ id: 'a', code: 'storeWrite' });
    expect(r.failed[0]!.inconsistent).toBeUndefined();
  });

  it('a move or a label rename that applied and then threw is recognized by its content', async () => {
    const inner = ordered();
    const { store, arm } = appliesThenThrows(inner);
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { list: { edges: store } } });
    await tc.tag(['a', 'b', 'c'], 'todo');
    arm();
    const m = await tc.moveInGroup('c', 'todo', { before: 'a' });
    expect(m.failed).toEqual([]);
    expect(members(tc, 'todo')).toEqual(['c', 'a', 'b']);
    arm();
    const r = await tc.renameGroup('todo', 'To do', { by: 'label' });
    expect(r.failed).toEqual([]);
    expect(tc.space().nodes.get(n('todo'))?.label).toBe('To do');
  });
});

describe('N2 — merging ordered groups re-ranks; a tie never throws', () => {
  it("from's members follow into's, in their order, with distinct ranks; moves and positions work", async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { list: { edges: ordered() } } });
    await tc.tag(['a', 'b'], 'f');
    await tc.tag(['c', 'd'], 'i');
    expect((await tc.mergeGroups('f', 'i')).ok).toBe(true);
    expect(members(tc, 'i')).toEqual(['c', 'd', 'a', 'b']);
    expect(new Set(ranks(tc, 'i')).size).toBe(4);
    expect((await tc.moveInGroup('b', 'i', { before: 'a' })).ok).toBe(true);
    expect(members(tc, 'i')).toEqual(['c', 'd', 'b', 'a']);
    await tc.untag(['d'], 'i');
    expect((await tc.tag(['d'], 'i', { position: { before: 'c' } })).ok).toBe(true);
    expect(members(tc, 'i')).toEqual(['d', 'c', 'b', 'a']);
  });

  it('foreign tied ranks: a move next to the tie is a per-item violation, not a throw', async () => {
    const s = ordered();
    await s.apply({
      added: [
        { id: 't1' as never, parent: n('i'), child: n('a'), kind: 'contains', order: 'V' },
        { id: 't2' as never, parent: n('i'), child: n('b'), kind: 'contains', order: 'V' },
        { id: 't3' as never, parent: n('i'), child: n('c'), kind: 'contains', order: 'W' },
      ],
    });
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { list: { edges: s } } });
    const r = await tc.moveInGroup('c', 'i', { after: 'a' });
    expect(r.failed[0]).toMatchObject({ id: 'c', code: 'violation' });
    expect(r.failed[0]!.reason).toMatch(/not before/);
  });
});

describe('N3 — reverting a move never overwrites a newer change', () => {
  it('refuses after another writer moved it again, and after it was untagged', async () => {
    const s = ordered();
    const provider = createInMemoryProvider(items());
    const tc1 = defineTaggedCollection<Item>({ provider, spaces: { list: { edges: s } } });
    const tc2 = defineTaggedCollection<Item>({ provider, spaces: { list: { edges: s } } });
    await tc1.tag(['a', 'b', 'c'], 'todo');
    const m = await tc1.moveInGroup('c', 'todo', { before: 'a' }); // c a b
    await tc2.load();
    await tc2.moveInGroup('c', 'todo', { after: 'a' }); // a c b
    const r1 = await tc1.revert(m.inverse);
    expect(r1.failed[0]).toMatchObject({ id: 'c', code: 'conflict' });
    await tc1.load();
    expect(members(tc1, 'todo')).toEqual(['a', 'c', 'b']);

    const m2 = await tc1.moveInGroup('c', 'todo', { before: 'a' });
    await tc2.load();
    await tc2.untag(['c'], 'todo');
    const r2 = await tc1.revert(m2.inverse);
    expect(r2.failed[0]).toMatchObject({ id: 'c', code: 'conflict' });
    await tc1.load();
    expect(members(tc1, 'todo')).toEqual(['a', 'b']);
  });
});

describe('N5 — unranked members', () => {
  it('get ranks (in their order) before anything is appended or moved among them', async () => {
    const s = ordered();
    await s.apply({
      added: [
        { id: 's1' as never, parent: n('todo'), child: n('a'), kind: 'contains' },
        { id: 's2' as never, parent: n('todo'), child: n('b'), kind: 'contains' },
      ],
    });
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { list: { edges: s } } });
    await tc.tag(['c'], 'todo');
    expect(members(tc, 'todo')).toEqual(['a', 'b', 'c']);
    expect((await tc.moveInGroup('b', 'todo', { before: 'a' })).ok).toBe(true);
    expect(members(tc, 'todo')).toEqual(['b', 'a', 'c']);
  });
});

describe('N6 — an embedded group that was only emptied', () => {
  it('is refused with a message that does not claim it was deleted', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: { embedded: 'tags' } } } });
    const u1 = await tc.untag(['a'], 'work');
    await tc.untag(['b'], 'work');
    const r = await tc.revert(u1.inverse);
    expect(r.failed[0]).toMatchObject({ id: 'a', code: 'conflict' });
    expect(r.failed[0]!.reason).toMatch(/emptied/);
  });
});
