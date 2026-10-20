/**
 * `mayRefusePlainItems(space, group, kind)`: when it says `false`, no plain item can be refused by
 * `validateEdge` — the guarantee the tagging menu's fast path rests on (issue #31). Checked on
 * random spaces under every built-in profile and edge kind, against the validator itself.
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  createGroupSpace,
  DEFAULT_EDGE_KINDS,
  edgeId,
  edgesInto,
  makeEdge,
  mayRefuseEmptying,
  mayRefusePlainItems,
  isMembershipKind,
  edgesOf,
  nodeId,
  validateEdge,
  type GroupSpace,
  type ProfileName,
} from '../src/index.js';

/** mulberry32: a tiny seeded PRNG, so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROFILES: ProfileName[] = ['filesystem', 'flatTags', 'nestedTags', 'labels', 'polyhierarchy', 'thesaurus', 'folksonomy'];
const KINDS = [...Object.keys(DEFAULT_EDGE_KINDS), 'undeclared'];

describe('mayRefusePlainItems is sound', () => {
  for (const profile of PROFILES) {
    it(`${profile}: false ⇒ validateEdge accepts every plain item`, () => {
      let fastRows = 0;
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const random = rng(seed * 31 + profile.length);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        const NODES = Array.from({ length: 16 }, (_, i) => `n${i}`);
        let space: GroupSpace = createGroupSpace({ profile });
        for (let step = 0; step < 60; step++) {
          const parent = pick(NODES);
          const child = pick(NODES.filter((n) => n !== parent));
          const r = applyDelta(space, { added: [makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`e${step}`), kind: pick(KINDS) })] });
          if (r.ok) space = r.value;
        }
        const nodes = [...NODES.map((n) => nodeId(n)), nodeId('fresh')]; // 'fresh' is not in the space
        for (const group of nodes) {
          for (const kind of KINDS) {
            if (mayRefusePlainItems(space, group, kind)) continue;
            fastRows += 1;
            for (const item of nodes) {
              if (item === group || (space.forward.get(item)?.size ?? 0) > 0) continue; // not a plain item
              if (edgesInto(space, item).some((e) => e.parent === group && e.kind === kind)) continue; // a duplicate
              expect(validateEdge(space, makeEdge(group, item, { kind })), `${group} ⊃ ${item} via ${kind}`).toEqual([]);
            }
          }
        }
      }
      if (['labels', 'polyhierarchy', 'nestedTags'].includes(profile)) expect(fastRows).toBeGreaterThan(0); // the fast path is exercised
    });
  }
});

describe('mayRefuseEmptying is sound', () => {
  for (const profile of PROFILES) {
    it(`${profile}: false ⇒ removing every member of the group is accepted`, () => {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const random = rng(seed * 53 + profile.length);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        const NODES = Array.from({ length: 16 }, (_, i) => `n${i}`);
        let space: GroupSpace = createGroupSpace({ profile });
        for (let step = 0; step < 60; step++) {
          const parent = pick(NODES);
          const child = pick(NODES.filter((n) => n !== parent));
          const r = applyDelta(space, { added: [makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`e${step}`), kind: pick(KINDS) })] });
          if (r.ok) space = r.value;
        }
        for (const group of NODES.map((n) => nodeId(n))) {
          if (mayRefuseEmptying(space, group)) continue;
          const removed = edgesOf(space, group).filter((e) => isMembershipKind(space.profile, e.kind)).map((e) => e.id);
          const result = applyDelta(space, { removed });
          expect(result.ok, `emptying ${group}: ${result.ok ? '' : JSON.stringify(result.violations)}`).toBe(true);
        }
      }
    });
  }
});
