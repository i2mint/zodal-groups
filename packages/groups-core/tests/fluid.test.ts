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
  nodeId,
  orphansOf,
  pinnedOf,
  smartGroup,
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

  it('extentOf applies the edits on the node of the same id to a predicate rule', () => {
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
    expect(extentOf(base, recent, [n('old'), n('new'), n('newer')])).toEqual(['new', 'old']);
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
});
