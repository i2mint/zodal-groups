/**
 * Validation must not depend on the order edges arrive in: whatever is refused in one order is
 * refused in the other, or an undo can be blocked forever by a state that should never have been
 * reachable.
 */

import { describe, expect, it } from 'vitest';
import { applyDelta, createGroupSpace, defineGroups, detectCycles, edgeId, makeEdge, nodeId, type Edge } from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, kind: string) =>
  makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}:${kind}`), kind });

const accepts = (...edges: Edge[]) => {
  let space = createGroupSpace({ profile: 'thesaurus' });
  for (const edge of edges) {
    const r = applyDelta(space, { added: [edge] });
    if (!r.ok) return r.violations.map((v) => v.code);
    space = r.value;
  }
  return 'ok';
};

describe('cycles through any hierarchical kind (M-1)', () => {
  it('a ⊃instance_of d, then d ⊃is_a a: refused in either order', () => {
    expect(accepts(e('a', 'd', 'instance_of'), e('d', 'a', 'is_a'))).toEqual(['cycle']);
    expect(accepts(e('d', 'a', 'is_a'), e('a', 'd', 'instance_of'))).toEqual(['cycle']);
  });

  it('detectCycles sees a cycle closed through an acyclic, non-transitive kind', () => {
    const s = createGroupSpace({ profile: 'thesaurus', edges: [e('a', 'd', 'instance_of')] });
    const cyclic = { ...s, edges: new Map(s.edges), forward: new Map(s.forward), inverse: new Map(s.inverse) };
    const back = e('d', 'a', 'is_a');
    cyclic.edges.set(back.id, back);
    cyclic.forward.set(n('d'), new Set([back.id]));
    cyclic.inverse.set(n('a'), new Set([back.id]));
    expect(detectCycles(cyclic).length).toBeGreaterThan(0);
  });

  it('the undo that used to be blocked forever now works', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    expect(g.add('d', 'a', { kind: 'instance_of' }).ok).toBe(true);
    expect(g.add('a', 'd', { kind: 'is_a' }).ok).toBe(false); // refused now, so no blocking state
  });
});

describe('disjointness is symmetric (M-2)', () => {
  it('related and contains between the same pair: refused in either order', () => {
    expect(accepts(e('p', 'c', 'related'), e('p', 'c', 'contains'))).toEqual(['disjointEdgeKind']);
    expect(accepts(e('p', 'c', 'contains'), e('p', 'c', 'related'))).toEqual(['disjointEdgeKind']);
  });

  it('…and whichever way round the pair is written', () => {
    expect(accepts(e('p', 'c', 'contains'), e('c', 'p', 'related'))).toEqual(['disjointEdgeKind']);
    expect(accepts(e('c', 'p', 'related'), e('p', 'c', 'contains'))).toEqual(['disjointEdgeKind']);
  });
});
