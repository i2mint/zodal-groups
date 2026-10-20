/**
 * `canApply` stages a delta copy-on-write; `applyDelta` stages it into eager copies. They must
 * report the same violations, in the same order, with the same text: the staged views keep a real
 * Map's and Set's iteration order, including a member removed and re-added in one delta (it moves
 * to the end, and family values are listed in the root's edge order).
 */

import { describe, expect, it } from 'vitest';
import { applyDelta, canApply, createGroupSpace, edgeId, makeEdge, nodeId } from '../src/index.js';

describe('canApply agrees with applyDelta', () => {
  it('a family edge removed and re-added keeps the order applyDelta reports', () => {
    const [F, V1, V2, x] = [nodeId('F'), nodeId('V1'), nodeId('V2'), nodeId('x')];
    const seeded = applyDelta(createGroupSpace({ profile: 'polyhierarchy' }), {
      upsertNodes: [{ id: F, family: { maxPerItem: 1 } }],
      added: [makeEdge(F, V1, { id: edgeId('e1') }), makeEdge(F, V2, { id: edgeId('e2') })],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.violations));
    const delta = {
      removed: [edgeId('e1')],
      added: [makeEdge(F, V1, { id: edgeId('e1') }), makeEdge(V1, x), makeEdge(V2, x)],
    };
    const applied = applyDelta(seeded.value, delta);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    const unminted = (vs: readonly unknown[]) => JSON.parse(JSON.stringify(vs).replace(/"id":"[^"]*"/g, '"id":""'));
    expect(unminted(canApply(seeded.value, delta))).toEqual(unminted(applied.violations));
  });
});
