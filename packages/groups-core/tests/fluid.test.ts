/**
 * Fluid groups (#44, D36): a smart group edited by hand. Pinned members are membership edges into
 * its node, excluded ones `excludes` edges; the extent is `rule(items) ∪ pinned \ excluded`, and the
 * persisted rule lives on the node (`Node.rule`).
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  createGroupSpace,
  edgeId,
  excludedOf,
  extentOf,
  fluidExtent,
  invert,
  isExcluded,
  isGroup,
  makeEdge,
  mergeDelta,
  nodeId,
  orphansOf,
  pinnedOf,
  smartGroup,
  unfiled,
  type Edge,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, kind = 'contains') => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}:${kind}`), kind });
const space = (...edges: Edge[]) => createGroupSpace<{ year: number }>({ profile: 'polyhierarchy', edges });
const codes = (r: ReturnType<typeof applyDelta>) => (r.ok ? [] : r.violations.map((v) => v.code));
const ok = <T>(r: { ok: true; value: T } | { ok: false }) => {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
};

describe('fluid groups', () => {
  it('extent = rule matches ∪ pinned \\ excluded, in that order', () => {
    const s = space(e('smart', 'p'), e('smart', 'x', 'excludes'));
    expect(fluidExtent(s, n('smart'), [n('a'), n('x'), n('b')])).toEqual(['a', 'b', 'p']);
    expect(pinnedOf(s, n('smart'))).toEqual(['p']);
    expect(excludedOf(s, n('smart'))).toEqual(['x']);
    expect(isExcluded(s, n('smart'), n('x'))).toBe(true);
    expect(isExcluded(s, n('smart'), n('p'))).toBe(false);
  });

  it('a pin the rule also matches is listed once', () => {
    const s = space(e('smart', 'a'));
    expect(fluidExtent(s, n('smart'), [n('a'), n('b')])).toEqual(['a', 'b']);
  });

  it('in an ordered space the pins come first, in rank order, then the unpinned matches (D37)', () => {
    const ranked = (child: string, order: string) =>
      makeEdge(n('smart'), n(child), { id: edgeId(`smart>${child}`), order });
    const s = createGroupSpace({ profile: 'filesystem', edges: [ranked('b', 'b'), ranked('p', 'a'), e('smart', 'x', 'excludes')] });
    expect(fluidExtent(s, n('smart'), [n('a'), n('b'), n('x'), n('c')])).toEqual(['p', 'b', 'a', 'c']);
  });

  it('fluidExtent edits a predicate rule\'s extent; extentOf alone stays the predicate', () => {
    const base = createGroupSpace<{ year: number }>({
      profile: 'polyhierarchy',
      nodes: [
        { id: n('old'), payload: { year: 1990 } },
        { id: n('new'), payload: { year: 2020 } },
        { id: n('newer'), payload: { year: 2024 } },
      ],
      edges: [e('recent', 'old'), e('recent', 'newer', 'excludes')],
    });
    const recent = smartGroup<{ year: number }>(n('recent'), 'Recent', (p) => (p?.year ?? 0) >= 2000);
    const pool = [n('old'), n('new'), n('newer')];
    expect(extentOf(base, recent, pool)).toEqual(['new', 'newer']);
    expect(fluidExtent(base, recent.id, extentOf(base, recent, pool))).toEqual(['new', 'old']);
  });

  it('excludes is not a membership: it files nothing and makes no group', () => {
    const s = space(e('smart', 'x', 'excludes'));
    expect(isGroup(s, n('smart'))).toBe(false);
    expect(orphansOf(s)).toContain(n('x'));
  });

  it('an item is pinned or excluded, not both', () => {
    const pinned = space(e('smart', 'a'));
    expect(codes(applyDelta(pinned, { added: [e('smart', 'a', 'excludes')] }))).toContain('disjointEdgeKind');
    const excluded = space(e('smart', 'a', 'excludes'));
    expect(codes(applyDelta(excluded, { added: [e('smart', 'a')] }))).toContain('disjointEdgeKind');
  });

  it('the rule is a node field: persisted, merged, inverted', () => {
    const rule = { field: 'path', operator: 'startsWith', value: 'music/jazz/' };
    const s0 = space();
    const s1 = ok(applyDelta(s0, { upsertNodes: [{ id: n('jazz'), label: 'Jazz', rule }] }));
    expect(s1.nodes.get(n('jazz'))?.rule).toEqual(rule);
    const wider = { or: [rule, { field: 'path', operator: 'startsWith', value: 'music/blues/' }] };
    const s2 = ok(applyDelta(s1, { upsertNodes: [{ id: n('jazz'), rule: wider }] }));
    const back = ok(applyDelta(s2, invert(s1, { upsertNodes: [{ id: n('jazz'), rule: wider }] })));
    expect(back.nodes.get(n('jazz'))?.rule).toEqual(rule);
    const cleared = ok(applyDelta(s2, { upsertNodes: [{ id: n('jazz'), rule: undefined }] }));
    expect(cleared.nodes.get(n('jazz'))).toEqual({ id: 'jazz', label: 'Jazz' });
  });

  it('a rule must be a plain JSON object', () => {
    const s = space();
    expect(codes(applyDelta(s, { upsertNodes: [{ id: n('g'), rule: 'path ~ music/*' as never }] }))).toEqual(['malformed']);
    expect(codes(applyDelta(s, { upsertNodes: [{ id: n('g'), rule: { value: () => true } }] }))).toEqual(['malformed']);
  });

  it('pins come in rank order in an ordered space', () => {
    const ranked = (child: string, order?: string) => makeEdge(n('list'), n(child), { id: edgeId(`list>${child}`), ...(order ? { order } : {}) });
    const s = createGroupSpace({ profile: 'filesystem', edges: [ranked('c', 'a2'), ranked('x'), ranked('a', 'a0'), ranked('b', 'a1')] });
    expect(pinnedOf(s, n('list'))).toEqual(['a', 'b', 'c', 'x']);
  });

  it('a node with a rule is a group before anything is pinned, never an unfiled item', () => {
    const s = ok(applyDelta(space(e('folder', 'a')), { upsertNodes: [{ id: n('smart'), rule: { field: 'x', operator: 'eq', value: 1 } }] }));
    expect(isGroup(s, n('smart'))).toBe(true);
    expect(orphansOf(s)).not.toContain(n('smart'));
    expect(unfiled(n('u')).rule(s.nodes.get(n('smart'))!, s)).toBe(false);
  });

  it('an exclusion is no ordering: it never closes a cycle', () => {
    const s = space(e('top', 'mid'), e('mid', 'smart'));
    expect(codes(applyDelta(s, { added: [e('smart', 'top', 'excludes')] }))).toEqual([]);
  });

  it('a merge carries the rule over to a group without one', () => {
    const rule = { field: 'x', operator: 'eq', value: 1 };
    const s = ok(applyDelta(space(e('smart', 'p'), e('smart', 'x', 'excludes'), e('plain', 'q')), { upsertNodes: [{ id: n('smart'), rule }] }));
    const merged = ok(applyDelta(s, mergeDelta(s, n('smart'), n('plain'))));
    expect(merged.nodes.get(n('plain'))?.rule).toEqual(rule);
    expect(excludedOf(merged, n('plain'))).toEqual(['x']);
    const other = { field: 'x', operator: 'eq', value: 2 };
    const both = ok(applyDelta(s, { upsertNodes: [{ id: n('plain'), rule: other }] }));
    expect(ok(applyDelta(both, mergeDelta(both, n('smart'), n('plain')))).nodes.get(n('plain'))?.rule).toEqual(other);
  });
});
