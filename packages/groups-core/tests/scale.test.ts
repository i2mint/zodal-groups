/**
 * Bulk writes stay linear. Checking a new edge must cost O(the child's parents), never O(the
 * group's members): 20k items tagged into one group took ~12 s when the duplicate and
 * disjointness checks listed the whole group per edge.
 */

import { describe, expect, it } from 'vitest';
import { applyDelta, createGroupSpace, edgeId, makeEdge, nodeId, type Edge } from '../src/index.js';

const BUDGET_MS = 2_000; // generous: linear work here is ~100 ms on a laptop

describe('bulk tagging is linear', () => {
  it('20,000 items into one group in one delta', () => {
    const added: Edge[] = [];
    for (let i = 0; i < 20_000; i++) added.push(makeEdge(nodeId('g'), nodeId(`item-${i}`), { id: edgeId(`g>item-${i}`) }));
    for (const profile of ['flatTags', 'polyhierarchy'] as const) {
      const start = performance.now();
      const r = applyDelta(createGroupSpace({ profile }), { added });
      const ms = performance.now() - start;
      expect(r.ok).toBe(true);
      expect(ms, `${profile}: ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    }
  });

  it('a second bulk delta into an already-large group', () => {
    const first: Edge[] = [];
    const second: Edge[] = [];
    for (let i = 0; i < 10_000; i++) {
      first.push(makeEdge(nodeId('g'), nodeId(`a-${i}`), { id: edgeId(`g>a-${i}`) }));
      second.push(makeEdge(nodeId('g'), nodeId(`b-${i}`), { id: edgeId(`g>b-${i}`) }));
    }
    const s1 = applyDelta(createGroupSpace(), { added: first });
    if (!s1.ok) throw new Error('seed');
    const start = performance.now();
    const r = applyDelta(s1.value, { added: second });
    expect(r.ok).toBe(true);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });
});
