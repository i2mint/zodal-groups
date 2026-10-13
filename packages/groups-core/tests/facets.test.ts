/**
 * `facetPanel` counts in one pass over the pool (issue #11). Two things are checked here:
 *
 * - **the same answer**: on random spaces over every built-in edge kind (so mixed kinds and
 *   composition are exercised), the panel equals the one the old per-candidate loop produced;
 * - **fast enough**: the annals page's shape (~600 items, five flat families, one with ~500
 *   values) counts all five panels well inside the ~400 ms Doherty budget. The old loop took
 *   ~635 ms for four panels on a server CPU, so 1–2 s per checkbox on a phone.
 */

import { describe, expect, it } from 'vitest';
import {
  allItems,
  applyDelta,
  closureIds,
  createGroupSpace,
  DEFAULT_EDGE_KINDS,
  descendants,
  edgeId,
  edgesInto,
  edgesOf,
  facetPanel,
  groupsOfItem,
  isGroup,
  makeEdge,
  matchingItems,
  nodeId,
  type Edge,
  type FacetOptions,
  type FacetValue,
  type GroupSpace,
  type NodeId,
  type ProfileName,
} from '../src/index.js';

/** The pre-#11 algorithm, kept verbatim as the oracle: O(candidates × pool). */
function referencePanel<P>(space: GroupSpace<P>, options: FacetOptions = {}): FacetValue[] {
  const { selected = new Set<NodeId>(), expand = 'closure', hideEmpty = true, under } = options;
  const items = [...(options.items ?? allItems(space))];
  const candidates = under
    ? [
        ...new Set(
          edgesOf(space, under)
            .filter((e) => space.profile.edgeKinds[e.kind]?.transitive)
            .map((e) => e.child)
            .filter((id) => isGroup(space, id)),
        ),
      ]
    : [...space.nodes.keys()].filter((id) => isGroup(space, id) && !edgesInto(space, id).length);
  const others = new Set([...selected].filter((g) => !candidates.includes(g)));
  const pool = others.size ? [...matchingItems(space, others, items)] : items;
  const out: FacetValue[] = [];
  for (const group of candidates) {
    const scope = expand === 'closure' ? new Set(closureIds(space, group)) : new Set([group]);
    const matched = new Set<NodeId>();
    for (const item of pool) {
      for (const g of groupsOfItem(space, item, 'direct')) {
        if (scope.has(g)) {
          matched.add(item);
          break;
        }
      }
    }
    const count = matched.size;
    if (hideEmpty && count === 0 && !selected.has(group)) continue;
    out.push({
      group,
      label: space.nodes.get(group)?.label ?? group,
      count,
      selected: selected.has(group),
      hasChildren: descendants(space, group).size > 0,
      depth: 0,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

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

describe('facetPanel gives the same answer as the per-candidate loop', () => {
  const NODES = Array.from({ length: 14 }, (_, i) => `n${i}`);
  const KINDS = Object.keys(DEFAULT_EDGE_KINDS);
  const PROFILES: ProfileName[] = ['polyhierarchy', 'thesaurus', 'labels', 'flatTags', 'folksonomy'];

  for (const profile of PROFILES) {
    for (const seed of [1, 2, 3, 4]) {
      it(`${profile}, seed ${seed}`, () => {
        const random = rng(seed * 101 + profile.length);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        let space: GroupSpace = createGroupSpace({ profile });
        for (let step = 0; step < 120; step++) {
          const parent = pick(NODES);
          const child = pick(NODES.filter((n) => n !== parent));
          const r = applyDelta(space, {
            added: [makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`e${step}`), kind: pick(KINDS) })],
          });
          if (r.ok) space = r.value; // a refused edge is just skipped
        }

        const live = [...space.nodes.keys()];
        for (let trial = 0; trial < 40; trial++) {
          const options: FacetOptions = {
            selected: new Set(live.filter(() => random() < 0.15)),
            expand: random() < 0.7 ? 'closure' : 'direct',
            hideEmpty: random() < 0.5,
            ...(random() < 0.6 ? { under: pick(live) } : {}),
            // Repeats included: a pool item listed twice is still one item.
            ...(random() < 0.5 ? { items: live.filter(() => random() < 0.6).flatMap((n) => (random() < 0.2 ? [n, n] : [n])) } : {}),
          };
          expect(facetPanel(space, options)).toEqual(referencePanel(space, options));
        }
      });
    }
  }
});

describe('facetPanel is fast enough for a real sidebar', () => {
  // A phone is 2–4× slower than a CI runner, so a quarter of the ~400 ms Doherty threshold, for all
  // five panels. One pass takes ~10 ms here; the old loop took ~120 ms on the same machine.
  const BUDGET_MS = 100;

  /** ~600 items in five flat families; `session` has ~500 values, most holding one item. */
  function annalsLike(): { space: GroupSpace; families: string[] } {
    const sizes: Record<string, number> = { source: 5, kind: 12, session: 500, month: 24, tag: 40 };
    const edges: Edge[] = [];
    const add = (parent: string, child: string) =>
      edges.push(makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`${parent}>${child}`) }));
    for (const [fam, n] of Object.entries(sizes)) for (let v = 0; v < n; v++) add(`fam:${fam}`, `${fam}:${v}`);
    const random = rng(7);
    for (let i = 0; i < 610; i++) {
      for (const [fam, n] of Object.entries(sizes)) {
        if (fam === 'tag') {
          const tags = new Set(Array.from({ length: Math.floor(random() * 4) }, () => Math.floor(random() * n)));
          for (const t of tags) add(`tag:${t}`, `item-${i}`);
        } else {
          add(`${fam}:${fam === 'session' ? Math.min(i, n - 1) : Math.floor(random() * n)}`, `item-${i}`);
        }
      }
    }
    // Load existing data in one go — `add()` in a loop copies the immutable space per edge.
    return { space: createGroupSpace({ profile: 'polyhierarchy', edges }), families: Object.keys(sizes) };
  }

  it('five families, two selections, counts excluding each family\'s own selection', () => {
    const { space, families } = annalsLike();
    const selected = new Set([nodeId('source:1'), nodeId('tag:3')]);
    const items = allItems(space).filter((id) => id.startsWith('item-'));
    expect(items).toHaveLength(610);

    const start = performance.now();
    const panels = families.map((fam) => facetPanel(space, { under: nodeId(`fam:${fam}`), selected, items }));
    const ms = performance.now() - start;

    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    expect(panels[families.indexOf('session')]!.length).toBeGreaterThan(0);
    // The N+1 rule: `source`'s unselected values still count (only `tag:3` narrows them).
    expect(panels[families.indexOf('source')]!.filter((f) => !f.selected).some((f) => f.count > 0)).toBe(true);
    // Spot-check against the oracle on the big family.
    const opts = { under: nodeId('fam:session'), selected, items };
    expect(facetPanel(space, opts)).toEqual(referencePanel(space, opts));
  });
});
