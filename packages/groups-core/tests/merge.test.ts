/**
 * `mergeDelta(space, from, into)`: re-point `from`'s memberships to `into` (skipping duplicates
 * and self-edges), then tombstone `from`. One delta, so one undo.
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  childrenOf,
  createGroupSpace,
  edgeId,
  invert,
  makeEdge,
  mergeDelta,
  nodeId,
  parentsOf,
  toSnapshot,
  type Edge,
  type GroupSpace,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, init: Partial<Omit<Edge, 'parent' | 'child'>> = {}) =>
  makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}`), ...init });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; violations: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.violations));
  return r.value;
};
const shape = (s: GroupSpace) => {
  const snap = toSnapshot(s);
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
  return { nodes: [...snap.nodes].sort(byId), edges: [...snap.edges].sort(byId) };
};

const tags = () =>
  createGroupSpace({
    nodes: [{ id: n('todo'), label: 'Todo', payload: { emoji: '☐' } }],
    edges: [e('todo', 'a'), e('todo', 'b', { label: 'B in todo', order: 'm' }), e('to-do', 'b'), e('to-do', 'c'), e('work', 'todo')],
  });

describe('mergeDelta', () => {
  it('re-points members and parents, skips duplicates, and tombstones `from`', () => {
    const before = tags();
    const merged = ok(applyDelta(before, mergeDelta(before, n('todo'), n('to-do'))));
    expect(merged.nodes.has(n('todo'))).toBe(false);
    expect(childrenOf(merged, n('to-do')).sort()).toEqual(['a', 'b', 'c']);
    expect(parentsOf(merged, n('to-do'))).toEqual(['work']);
    expect(parentsOf(merged, n('b'))).toEqual(['to-do']); // the duplicate was skipped, not doubled
  });

  it('carries the edge kind, label, order and meta of a re-pointed membership', () => {
    const s = createGroupSpace({ edges: [e('old', 'x', { kind: 'is_a', label: 'X', order: 'k', meta: { by: 'ann' } })] });
    const merged = ok(applyDelta(s, mergeDelta(s, n('old'), n('new'))));
    const moved = [...merged.edges.values()].find((x) => x.child === 'x')!;
    expect(moved).toMatchObject({ parent: 'new', kind: 'is_a', label: 'X', order: 'k', meta: { by: 'ann' } });
  });

  it('is undone exactly by its inverse', () => {
    const before = tags();
    const d = mergeDelta(before, n('todo'), n('to-do'));
    const merged = ok(applyDelta(before, d));
    expect(shape(ok(applyDelta(merged, invert(before, d))))).toEqual(shape(before));
  });

  it('drops the edge between the two instead of making a self-edge', () => {
    const s = createGroupSpace({ edges: [e('outer', 'inner'), e('inner', 'x'), e('outer', 'y')] });
    const intoOuter = ok(applyDelta(s, mergeDelta(s, n('inner'), n('outer'))));
    expect(childrenOf(intoOuter, n('outer')).sort()).toEqual(['x', 'y']);
    const intoInner = ok(applyDelta(s, mergeDelta(s, n('outer'), n('inner'))));
    expect(childrenOf(intoInner, n('inner')).sort()).toEqual(['x', 'y']);
  });

  it('a merge that would close a cycle is refused by applyDelta, with the path', () => {
    const s = createGroupSpace({ edges: [e('from', 'mid'), e('mid', 'into')] });
    const r = applyDelta(s, mergeDelta(s, n('from'), n('into')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.code === 'cycle' && v.path?.length)).toBe(true);
  });

  it('accepts an id minter', () => {
    const s = tags();
    const d = mergeDelta(s, n('todo'), n('to-do'), { mintId: (parent, child, kind) => edgeId(`${parent}|${kind}|${child}`) });
    expect(d.added?.map((x) => x.id).sort()).toEqual(['to-do|contains|a', 'work|contains|to-do']);
  });

  it('refuses merging a node into itself, and is empty for an unknown node', () => {
    expect(() => mergeDelta(tags(), n('todo'), n('todo'))).toThrow(/itself/);
    expect(mergeDelta(tags(), n('nope'), n('to-do'))).toEqual({ added: [], removed: [] });
  });
});
