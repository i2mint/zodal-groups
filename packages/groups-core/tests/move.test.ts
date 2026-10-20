/**
 * `moveDelta` / `moveTo`: a move re-points the edge, it does not replace it with a bare one.
 * The moved edge keeps its kind, label and meta; a ranked edge is re-ranked at the end of the new
 * parent; `init.kind` picks one edge when several link the old parent to the child (issue #25).
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  compareOrder,
  createGroupSpace,
  defineGroups,
  edgeId,
  edgesInto,
  edgesOf,
  invert,
  makeEdge,
  moveDelta,
  moveTo,
  nodeId,
  type Edge,
  type GroupSpace,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, init: Partial<Omit<Edge, 'parent' | 'child'>> = {}) =>
  makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}:${init.kind ?? 'contains'}`), ...init });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; violations: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.violations));
  return r.value;
};
const into = (s: GroupSpace, child: string, parent: string) => edgesInto(s, n(child)).filter((x) => x.parent === n(parent));

describe('moveTo keeps the moved edge', () => {
  it("keeps a thesaurus edge's kind, label and meta", () => {
    const space = createGroupSpace({
      profile: 'thesaurus',
      edges: [e('car', 'wheel', { kind: 'part_of', label: 'Front wheel', meta: { torque: 120 } })],
    });
    const moved = ok(moveTo(space, n('wheel'), n('car'), n('bike')));
    expect(into(moved, 'wheel', 'car')).toEqual([]);
    const [edge] = into(moved, 'wheel', 'bike');
    expect(edge).toMatchObject({ kind: 'part_of', label: 'Front wheel', meta: { torque: 120 } });
  });

  it('re-ranks a ranked edge after the new parent\'s last child (filesystem)', () => {
    const space = createGroupSpace({
      profile: 'filesystem',
      edges: [e('a', 'doc', { order: 'a' }), e('b', 'x', { order: 'm' }), e('b', 'y', { order: 'q' }), e('b', 'z')],
    });
    const moved = ok(moveTo(space, n('doc'), n('a'), n('b')));
    const [edge] = into(moved, 'doc', 'b');
    expect(edge!.order).toBeDefined();
    expect(compareOrder(edge!.order, 'q')).toBeGreaterThan(0);
    const ranks = edgesOf(moved, n('b')).map((x) => x.order).filter((o) => o !== undefined);
    expect(new Set(ranks).size).toBe(ranks.length); // no tie
  });

  it('an explicit init.order places it; other init fields override the carried ones', () => {
    const space = createGroupSpace({ profile: 'filesystem', edges: [e('a', 'doc', { order: 'm', label: 'Old' })] });
    const moved = ok(moveTo(space, n('doc'), n('a'), n('b'), { order: 'c', label: 'New' }));
    expect(into(moved, 'doc', 'b')[0]).toMatchObject({ order: 'c', label: 'New', kind: 'contains' });
  });

  it('leaves an unranked edge unranked', () => {
    const space = createGroupSpace({ profile: 'filesystem', edges: [e('a', 'doc'), e('b', 'x', { order: 'm' })] });
    const moved = ok(moveTo(space, n('doc'), n('a'), n('b')));
    expect(into(moved, 'doc', 'b')[0]!.order).toBeUndefined();
  });

  it('init.kind moves only that edge; without it every edge from `from` moves, each with its kind', () => {
    const space = () =>
      createGroupSpace({ profile: 'thesaurus', edges: [e('car', 'wheel', { kind: 'part_of' }), e('car', 'wheel', { kind: 'instance_of' })] });

    const one = ok(moveTo(space(), n('wheel'), n('car'), n('bike'), { kind: 'part_of' }));
    expect(into(one, 'wheel', 'car').map((x) => x.kind)).toEqual(['instance_of']);
    expect(into(one, 'wheel', 'bike').map((x) => x.kind)).toEqual(['part_of']);

    const all = ok(moveTo(space(), n('wheel'), n('car'), n('bike')));
    expect(into(all, 'wheel', 'car')).toEqual([]);
    expect(into(all, 'wheel', 'bike').map((x) => x.kind).sort()).toEqual(['instance_of', 'part_of']);
  });

  it('with no edge from `from`, it is a plain add of init.kind (default contains)', () => {
    const space = createGroupSpace({ profile: 'thesaurus' });
    expect(moveDelta(space, n('x'), n('a'), n('b')).added![0]).toMatchObject({ parent: 'b', child: 'x', kind: 'contains' });
    expect(moveDelta(space, n('x'), n('a'), n('b'), { kind: 'is_a' }).added![0]!.kind).toBe('is_a');
  });

  it('refuses one id for two moved edges', () => {
    const space = createGroupSpace({
      profile: 'thesaurus',
      edges: [e('car', 'wheel', { kind: 'part_of' }), e('car', 'wheel', { kind: 'instance_of' })],
    });
    expect(() => moveDelta(space, n('wheel'), n('car'), n('bike'), { id: edgeId('x') })).toThrow(/init\.kind/);
    expect(moveDelta(space, n('wheel'), n('car'), n('bike'), { id: edgeId('x'), kind: 'part_of' }).added![0]!.id).toBe('x');
  });

  it('inverts exactly: the original edge comes back with its id and fields', () => {
    const original = e('car', 'wheel', { kind: 'part_of', label: 'Front', order: 'm', meta: { a: 1 } });
    const space = createGroupSpace({ profile: 'thesaurus', edges: [original] });
    const delta = moveDelta(space, n('wheel'), n('car'), n('bike'));
    const moved = ok(applyDelta(space, delta));
    const back = ok(applyDelta(moved, invert(space, delta)));
    expect([...back.edges.values()]).toEqual([original]);
  });

  it('Groups.move takes the kind, and undo restores the edge', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    g.add('wheel', 'car', { kind: 'part_of', label: 'Front' });
    g.add('wheel', 'car', { kind: 'instance_of' });
    expect(g.move('wheel', 'car', 'bike', { kind: 'part_of' }).ok).toBe(true);
    expect(into(g.space, 'wheel', 'bike')).toMatchObject([{ kind: 'part_of', label: 'Front' }]);
    expect(into(g.space, 'wheel', 'car').map((x) => x.kind)).toEqual(['instance_of']);
    expect(g.undo()).toBe(true);
    expect(into(g.space, 'wheel', 'bike')).toEqual([]);
    expect(into(g.space, 'wheel', 'car').map((x) => x.kind).sort()).toEqual(['instance_of', 'part_of']);
  });
});
