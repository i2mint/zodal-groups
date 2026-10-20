/**
 * `facetPanel` counts in one pass over the pool (issue #11). Two things are checked here:
 *
 * - **the same answer**: on random spaces over every built-in edge kind (so mixed kinds and
 *   composition are exercised), the panel equals a per-candidate loop over the definition: an item
 *   counts towards a group when it is in `descendants(space, group)` (issue #27: the item's own
 *   edge kind composes too, so `wheel part_of car is_a vehicle` does not count the wheel in
 *   `vehicle`);
 * - **fast enough**: the annals page's shape (~600 items, five flat families, one with ~500
 *   values) counts all five panels well inside the ~400 ms Doherty budget. The old loop took
 *   ~635 ms for four panels on a server CPU, so 1–2 s per checkbox on a phone.
 */

import { describe, expect, it } from 'vitest';
import {
  allItems,
  ancestors,
  applyDelta,
  createGroupSpace,
  DEFAULT_EDGE_KINDS,
  descendants,
  edgeId,
  edgesInto,
  browseRootsOf,
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
import { closureScope } from '../src/closure.js';

/** The definition, as the oracle: O(candidates × pool), one closure walk per group. */
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
    : browseRootsOf(space).filter((id) => isGroup(space, id));
  const others = new Set([...selected].filter((g) => !candidates.includes(g)));
  const within = (group: NodeId) => descendants(space, group);
  const othersClosures = [...others].map(within);
  const pool = others.size ? [...new Set(items.filter((item) => othersClosures.some((d) => d.has(item))))] : items;
  const out: FacetValue[] = [];
  for (const group of candidates) {
    const inside =
      expand === 'closure'
        ? within(group)
        : new Set(edgesOf(space, group).filter((e) => space.profile.edgeKinds[e.kind]?.transitive).map((e) => e.child));
    const matched = new Set<NodeId>(pool.filter((item) => inside.has(item)));
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

describe('facet values compose edge kinds from the item up (issue #27)', () => {
  // wheel part_of car is_a vehicle: a wheel is not a vehicle. sedan is_a car part_of fleet: a
  // sedan IS part of the fleet (is_a ∘ part_of → part_of).
  const space = () =>
    createGroupSpace({
      profile: 'thesaurus',
      edges: [
        makeEdge(nodeId('car'), nodeId('wheel'), { kind: 'part_of' }),
        makeEdge(nodeId('vehicle'), nodeId('car'), { kind: 'is_a' }),
        makeEdge(nodeId('car'), nodeId('sedan'), { kind: 'is_a' }),
        makeEdge(nodeId('fleet'), nodeId('car'), { kind: 'part_of' }),
      ],
    });
  const ids = (xs: Iterable<NodeId>) => [...xs].sort();

  it('groupsOfItem is ancestors: the wheel is in car and fleet, not vehicle; the sedan is in all three', () => {
    const s = space();
    expect(ids(groupsOfItem(s, nodeId('wheel')))).toEqual(['car', 'fleet']);
    expect(ids(groupsOfItem(s, nodeId('wheel')))).toEqual(ids(ancestors(s, nodeId('wheel'))));
    expect(ids(groupsOfItem(s, nodeId('sedan')))).toEqual(['car', 'fleet', 'vehicle']);
  });

  it('facet counts and matching agree with it', () => {
    const s = space();
    const counts = Object.fromEntries(facetPanel(s, { hideEmpty: false }).map((v) => [v.group, v.count]));
    expect(counts).toEqual({ vehicle: 1, fleet: 2 }); // vehicle: sedan; fleet: wheel and sedan
    expect(ids(matchingItems(s, [nodeId('vehicle')]))).toEqual(['sedan']);
    expect(ids(matchingItems(s, [nodeId('fleet')]))).toEqual(['sedan', 'wheel']);
  });

  it('on random spaces, groupsOfItem = ancestors and matchingItems = the union of descendants', () => {
    const NODES = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const KINDS = Object.keys(DEFAULT_EDGE_KINDS);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = rng(seed * 7919);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
      let s: GroupSpace = createGroupSpace({ profile: 'thesaurus' });
      for (let step = 0; step < 80; step++) {
        const parent = pick(NODES);
        const child = pick(NODES.filter((n) => n !== parent));
        const r = applyDelta(s, { added: [makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`e${step}`), kind: pick(KINDS) })] });
        if (r.ok) s = r.value;
      }
      const live = [...s.nodes.keys()];
      for (const node of live) expect(ids(groupsOfItem(s, node))).toEqual(ids(ancestors(s, node)));
      for (let trial = 0; trial < 20; trial++) {
        const selected = live.filter(() => random() < 0.2);
        const expected = live.filter((n) => selected.some((g) => descendants(s, g).has(n)));
        expect(ids(matchingItems(s, selected, live))).toEqual(ids(selected.length ? expected : live));
      }
    }
  });
});

describe('closureScope is descendants, seen from the item (with kinds and maxDepth)', () => {
  it('on random thesaurus spaces, an edge lands in the scope with its kind iff its child is a descendant', () => {
    const NODES = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const KINDS = Object.keys(DEFAULT_EDGE_KINDS);
    const TRANSITIVE = KINDS.filter((k) => DEFAULT_EDGE_KINDS[k]!.transitive);
    for (const seed of [11, 12, 13, 14, 15]) {
      const random = rng(seed * 104729);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
      let s: GroupSpace = createGroupSpace({ profile: 'thesaurus' });
      for (let step = 0; step < 80; step++) {
        const parent = pick(NODES);
        const child = pick(NODES.filter((n) => n !== parent));
        const r = applyDelta(s, { added: [makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`e${step}`), kind: pick(KINDS) })] });
        if (r.ok) s = r.value;
      }
      const live = [...s.nodes.keys()];
      for (let trial = 0; trial < 30; trial++) {
        const group = pick(live);
        const options = {
          ...(random() < 0.5 ? { kinds: TRANSITIVE.filter(() => random() < 0.6) } : {}),
          ...(random() < 0.5 ? { maxDepth: Math.floor(random() * 4) } : {}),
        };
        const scope = closureScope(s, group, options);
        const below = descendants(s, group, options);
        for (const node of live) {
          if (node === group) continue;
          const reached = edgesInto(s, node).some((e) => scope.get(e.parent)?.has(e.kind) === true);
          expect(reached, `${node} under ${group} ${JSON.stringify(options)}`).toBe(below.has(node));
        }
      }
    }
  });
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

    // One untimed pass first: the budget guards the algorithm (~10 ms warm), not the JIT's first
    // compile on a CI runner shared with the fs store's multi-process test.
    facetPanel(space, { under: nodeId(`fam:${families[0]}`), selected, items });
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
