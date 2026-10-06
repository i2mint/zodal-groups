/**
 * Property test over random deltas (seeded, so failures reproduce): every built-in edge kind,
 * several profiles, adds / removals / relabels / deletes / merges / family rules / multi-edge
 * deltas. For every accepted delta:
 *
 * - apply ∘ invert = identity           (undo restores the exact nodes and edges)
 * - invert ∘ invert = the original effect (redo restores the exact result)
 * - every state reloads                 (JSON → parseSnapshot → fromSnapshot gives the same space)
 * - every state is valid, in any order  (validateProfile is empty, and empty with edges reversed)
 *
 * A refused delta changes nothing. And at the end the whole history undoes, LIFO, to empty — a
 * single writer's undo is never refused. The order-dependent cycle and disjointness checks
 * (PR review, round 2) were found by exactly this kind of run.
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  DEFAULT_EDGE_KINDS,
  defineGroups,
  deleteNodeDelta,
  edgeId,
  fromSnapshot,
  invert,
  makeEdge,
  mergeDelta,
  nodeId,
  parseSnapshot,
  toSnapshot,
  validateProfile,
  type EdgeDelta,
  type GroupSpace,
  type ProfileName,
} from '../src/index.js';

/** mulberry32: a tiny seeded PRNG. */
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

/** Canonical JSON of the nodes and edges, ignoring revision and key order. */
function shape(space: GroupSpace): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  const snap = toSnapshot(space);
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify(canonical({ nodes: [...snap.nodes].sort(byId), edges: [...snap.edges].sort(byId) }));
}

const NODES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const KINDS = Object.keys(DEFAULT_EDGE_KINDS);
const PROFILES: ProfileName[] = ['polyhierarchy', 'labels', 'nestedTags', 'flatTags', 'filesystem', 'thesaurus', 'folksonomy'];
const STEPS = 300;
const SEEDS = [1, 2, 3];

function randomDelta(space: GroupSpace, random: () => number, step: number): EdgeDelta {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const live = [...space.nodes.keys()];
  const edges = [...space.edges.values()];
  const addEdge = (suffix = '') => {
    const parent = pick(NODES);
    let child = pick(NODES);
    if (child === parent) child = NODES[(NODES.indexOf(parent) + 1) % NODES.length]!;
    return makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`s${step}${suffix}`), kind: pick(KINDS) });
  };
  const r = random();
  if (r < 0.35 || !live.length) return { added: [addEdge()] };
  if (r < 0.45) return { added: [addEdge('x'), addEdge('y')] };
  if (r < 0.6 && edges.length) return { removed: [pick(edges).id] };
  if (r < 0.7) return { upsertNodes: [{ id: nodeId(pick(NODES)), label: `L${step}`, payload: { step } }] };
  if (r < 0.8) return deleteNodeDelta(space, pick(live));
  if (r < 0.9 && live.length > 1) {
    const from = pick(live);
    const into = pick(live.filter((x) => x !== from));
    return mergeDelta(space, from, into, { mintId: (p, c, k) => edgeId(`s${step}:${p}>${c}:${k}`) });
  }
  return { upsertNodes: [{ id: pick(live), family: random() < 0.3 ? undefined : { maxPerItem: 1 + Math.floor(random() * 2) } }] };
}

describe('properties over random deltas', () => {
  for (const profile of PROFILES) {
    for (const seed of SEEDS) {
      it(`${profile}, seed ${seed}: undo, redo, reload and validity hold for every state`, () => {
        const random = rng(seed * 7919 + PROFILES.indexOf(profile));
        const g = defineGroups({ profile });
        let accepted = 0;

        for (let step = 0; step < STEPS; step++) {
          const before = g.space;
          const delta = randomDelta(before, random, step);
          const result = g.apply(delta);
          if (!result.ok) {
            expect(g.space, `step ${step}: a refused delta changed the space`).toBe(before);
            continue;
          }
          accepted += 1;
          const after = g.space;
          const where = `${profile}/${seed} step ${step}: ${JSON.stringify(delta)}`;

          const undo = invert(before, delta);
          const back = applyDelta(after, undo);
          expect(back.ok, `${where}\nundo refused: ${JSON.stringify(!back.ok && back.violations)}`).toBe(true);
          if (!back.ok) return;
          expect(shape(back.value), `${where}\nundo is not exact`).toBe(shape(before));

          const redo = applyDelta(back.value, invert(after, undo));
          expect(redo.ok, `${where}\nredo refused: ${JSON.stringify(!redo.ok && redo.violations)}`).toBe(true);
          if (redo.ok) expect(shape(redo.value), `${where}\nredo is not exact`).toBe(shape(after));

          const reloaded = fromSnapshot(parseSnapshot(JSON.parse(JSON.stringify(toSnapshot(after)))), { profile: after.profile });
          expect(shape(reloaded), `${where}\nreload differs`).toBe(shape(after));

          expect(validateProfile(after), `${where}\nstate invalid`).toEqual([]);
          const reversed = fromSnapshot({ nodes: [...after.nodes.values()].reverse(), edges: [...after.edges.values()].reverse() }, { profile: after.profile });
          expect(validateProfile(reversed), `${where}\nstate invalid in reverse edge order`).toEqual([]);
        }

        expect(accepted).toBeGreaterThan(STEPS / 5); // the generator is not just producing refusals
        while (g.undoDepth > 0) {
          const why = g.undoViolations();
          expect(why, `${profile}/${seed}: LIFO undo refused at depth ${g.undoDepth}`).toEqual([]);
          if (why.length) return;
          expect(g.undo()).toBe(true);
        }
        expect(g.space.nodes.size + g.space.edges.size).toBe(0);
      });
    }
  }
});
