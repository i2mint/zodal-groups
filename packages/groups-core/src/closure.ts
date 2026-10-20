/**
 * Transitive closure over the group DAG — the engine behind "everything in this folder, including
 * subfolders".
 *
 * Two things make this module more subtle than it first looks.
 *
 * **1. Closure is a property of the edge *kind*, not of the system.** Walking every edge blindly
 * produces false conclusions: a *wheel* is `part_of` a *car*, and a *car* `is_a` *vehicle*, but a
 * wheel is emphatically not a vehicle. SKOS makes `broader` non-transitive for exactly this reason,
 * and the Gene Ontology only earns transitivity by declaring composition rules
 * (`is_a ∘ part_of → part_of`) and excluding the unsafe combinations. So `walk` consults
 * `EdgeKindDef.transitive` and `EdgeKindDef.composesWith` at every hop, and stops where the chain
 * does not compose.
 *
 * **2. Everything must be de-duplicated, and everything must terminate.** In a DAG a node is
 * reachable by many paths, so an un-memoized traversal is O(2^n) and an un-deduplicated count
 * double-counts. Every function here memoizes (on node id, or node + chain state) and guards against revisits — including
 * against *cycles*, which the write path forbids but which can still arrive from a store adapter or
 * an import that never heard of our invariant. A projection that assumes acyclicity is a projection
 * that hangs the browser on someone else's bad data.
 *
 * The closure cache covers the **group DAG only** — never the items. That asymmetry is the whole
 * performance story: the taxonomy is tiny (hundreds to thousands of nodes) while the item set is
 * huge (millions), so the cache is cheap to rebuild from scratch on every write, and no item row is
 * ever touched when the taxonomy changes. The "update storm" that sinks item-level closure
 * materialization is structurally absent here, and with it goes the whole `path_count`/DRed
 * deletion problem.
 *
 * @see `docs/research/_reconciliation.md` — decisions D9, D10, §2.2, §2.4.
 */

import type { EdgeKind, GroupSpace, NodeId } from './model.js';
import type { GroupProfile } from './profile.js';
import { edgesInto, edgesOf, isAcyclicKind } from './space.js';

/**
 * The kind of the chain `lower` then `upper`, read child-first as the Gene Ontology writes it
 * (`A is_a B`, `B part_of C` ⇒ `A part_of C`: `is_a ∘ part_of → part_of`), or `null` when it does
 * not compose. `composesWith` is declared on the lower (child-side) kind and keyed by the upper
 * one, and this is the ONE order both walks use: going up, the chain so far is the lower part;
 * going down, it is the upper part. (Composing in walk order instead made `ancestors` and
 * `descendants` disagree on mixed-kind chains — issue #6.)
 */
function composeKinds(profile: GroupProfile, lower: EdgeKind, upper: EdgeKind): EdgeKind | null {
  const lowerDef = profile.edgeKinds[lower];
  if (!lowerDef?.transitive || !profile.edgeKinds[upper]?.transitive) return null;
  // With no declared composition, a chain only continues through the *same* kind. This is the
  // conservative reading, and it is the one that keeps `part_of ∘ is_a` from concluding nonsense.
  if (!lowerDef.composesWith) return lower === upper ? lower : null;
  return lowerDef.composesWith[upper] ?? null;
}

export interface WalkOptions {
  /** Restrict the walk to these kinds. Defaults to every transitive kind in the profile. */
  readonly kinds?: readonly EdgeKind[];
  /** Stop after this many hops. */
  readonly maxDepth?: number;
}

/**
 * Everything reachable *below* `root` — its descendants. De-duplicated, cycle-safe.
 *
 * Excludes `root` itself. This is the set you expand a group id into before filtering items.
 */
export function descendants(space: GroupSpace, root: NodeId, options: WalkOptions = {}): Set<NodeId> {
  return walk(space, root, 'down', options);
}

/**
 * Everything reachable *above* `node` — its ancestors. De-duplicated, cycle-safe.
 *
 * Under polyhierarchy this is a *set*, not a chain — and the diamond case is why de-duplication is
 * mandatory: if an item is in A, and A is under both B and C, and B and C are both under D, then D
 * must appear exactly once.
 */
export function ancestors(space: GroupSpace, node: NodeId, options: WalkOptions = {}): Set<NodeId> {
  return walk(space, node, 'up', options);
}

/**
 * How a walk carries a chain: `start` is the state before the first hop, `step` extends it by one
 * edge — `undefined` when nothing further along can be reached, else the new state, whether the
 * node at the far end is in the closure, and whether a longer chain could still compose. `key` makes a state hashable for the visited set.
 */
interface Chain<S> {
  readonly start: S;
  step(state: S, kind: EdgeKind): { readonly state: S; readonly reached: boolean; readonly extends: boolean } | undefined;
  key(state: S): string;
}

/**
 * Up: the chain so far is the lower part, so it is folded child-first as it is walked — the state
 * is the composed kind (`null` before the first hop).
 */
function upChain(profile: GroupProfile): Chain<EdgeKind | null> {
  return {
    start: null,
    step(carried, kind) {
      const composed = carried === null ? (profile.edgeKinds[kind]?.transitive ? kind : null) : composeKinds(profile, carried, kind);
      // A composed kind that is not transitive (a custom `composesWith` may yield one) still
      // reaches this node, and ends the chain.
      return composed === null ? undefined : { state: composed, reached: true, extends: profile.edgeKinds[composed]?.transitive === true };
    },
    key: (carried) => carried ?? '',
  };
}

/**
 * Down: the chain so far is the UPPER part, but the fold is child-first, and composition need not
 * be associative (`is_a ∘ part_of` composes, `part_of ∘ is_a` does not). So the state is the upper
 * part as a function: for each kind a chain could arrive with from below, the kind it ends as at
 * the start (or `null`). A node is reached when its own edge, as the first hop, survives that
 * function — exactly what `ancestors` would conclude from below. A node that is not reached still
 * passes the function on: a longer chain through it may compose where its own edge does not.
 */
/** The upper part of a down walk's chain, interned: one object per distinct function. */
interface UpperChain {
  /** For each kind a chain could arrive with from below, the kind it ends as (`null`: it breaks). */
  readonly ends: ReadonlyMap<EdgeKind, EdgeKind | null> | 'identity';
  readonly key: string;
}

function downChain(profile: GroupProfile): Chain<UpperChain> {
  const transitive = Object.keys(profile.edgeKinds).filter((k) => profile.edgeKinds[k]?.transitive);
  // The identity is a marker, not a map over the transitive kinds: a composed kind may be one that
  // is not transitive (or not declared), and the empty upper chain must still map it to itself.
  const identity: UpperChain = { ends: 'identity', key: '\u0002' };
  const look = (above: UpperChain, k: EdgeKind): EdgeKind | null =>
    above.ends === 'identity' ? k : (above.ends.get(k) ?? null);
  // A walk meets few distinct states (functions over a handful of kinds) but many edges: intern
  // the states and cache each (state, kind) transition, so an edge costs one map lookup.
  const interned = new Map<string, UpperChain>([[identity.key, identity]]);
  type Step = { readonly state: UpperChain; readonly reached: boolean; readonly extends: boolean } | undefined;
  const transitions = new Map<string, Step>();
  const compute = (above: UpperChain, kind: EdgeKind): Step => {
    if (!profile.edgeKinds[kind]?.transitive) return undefined; // no chain passes through it
    const reached = look(above, kind) !== null;
    const ends = new Map<EdgeKind, EdgeKind | null>();
    let alive = false;
    for (const k of transitive) {
      const composed = composeKinds(profile, k, kind);
      const end = composed === null ? null : look(above, composed);
      ends.set(k, end);
      if (end !== null) alive = true;
    }
    if (!alive && !reached) return undefined;
    const key = [...ends.values()].map((v) => v ?? '').join('\u0001');
    let state = interned.get(key);
    if (!state) interned.set(key, (state = { ends, key }));
    return { state, reached, extends: alive };
  };
  return {
    start: identity,
    step(above, kind) {
      const t = `${above.key}\u0003${kind}`;
      if (transitions.has(t)) return transitions.get(t);
      const result = compute(above, kind);
      transitions.set(t, result);
      return result;
    },
    key: (state) => state.key,
  };
}

// One chain per profile (profiles are not mutated), so a down walk's transition cache is shared by
// every walk over the same profile — facetPanel walks once per candidate.
const upChains = new WeakMap<GroupProfile, Chain<EdgeKind | null>>();
const downChains = new WeakMap<GroupProfile, Chain<UpperChain>>();

function downChainOf(profile: GroupProfile): Chain<UpperChain> {
  let chain = downChains.get(profile);
  if (!chain) downChains.set(profile, (chain = downChain(profile)));
  return chain;
}

function walk(
  space: GroupSpace,
  start: NodeId,
  direction: 'up' | 'down',
  options: WalkOptions,
): Set<NodeId> {
  const profile = space.profile;
  if (direction === 'up') {
    let chain = upChains.get(profile);
    if (!chain) upChains.set(profile, (chain = upChain(profile)));
    return walkChain(space, start, 'up', chain, options);
  }
  return walkChain(space, start, 'down', downChainOf(profile), options);
}

/**
 * Where an item must sit to be in `group`'s closure: each group in the closure (`group` included),
 * with the kinds the item's OWN edge into it may have.
 *
 * The kind of the item's edge matters, because closure composes: with `wheel part_of car` and
 * `car is_a vehicle`, `car` is in `vehicle`'s closure, but `wheel` is not (`part_of ∘ is_a` does
 * not compose). So "is the item's group in the closure?" over-counts; "is the item's group in the
 * scope, with an edge of an accepted kind?" is exactly `descendants(space, group).has(item)`,
 * answered from the item's side without walking the items. This is what facet counts and matching
 * use, so they agree with `ancestors` and `descendants`.
 *
 * Only nodes with children appear (an item's group has at least that item).
 */
export function closureScope(space: GroupSpace, group: NodeId, options: WalkOptions = {}): Map<NodeId, ReadonlySet<EdgeKind>> {
  const profile = space.profile;
  const chain = downChainOf(profile);
  const allowed = options.kinds ? new Set(options.kinds) : null;
  const kinds = Object.keys(profile.edgeKinds).filter((k) => profile.edgeKinds[k]?.transitive && (!allowed || allowed.has(k)));
  const scope = new Map<NodeId, Set<EdgeKind>>();
  walkChain(space, group, 'down', chain, options, (node, state) => {
    if (!space.forward.get(node)?.size) return;
    for (const k of kinds) {
      if (!chain.step(state, k)?.reached) continue;
      const set = scope.get(node);
      if (set) set.add(k);
      else scope.set(node, new Set([k]));
    }
  });
  return scope;
}

function walkChain<S>(
  space: GroupSpace,
  start: NodeId,
  direction: 'up' | 'down',
  chain: Chain<S>,
  options: WalkOptions,
  /** Called for each (node, chain state) the walk expands, `start` included. */
  onExpand?: (node: NodeId, state: S) => void,
): Set<NodeId> {
  const out = new Set<NodeId>();
  const allowed = options.kinds ? new Set(options.kinds) : null;
  const maxDepth = options.maxDepth ?? Infinity;

  // `visited` is keyed by (node, chain state): the same node reached with a different chain may
  // compose further, so reachability never depends on BFS order. Still finite (nodes × states),
  // so still the cycle guard.
  const visitKey = (node: NodeId, state: S) => `${chain.key(state)}\u0000${node}`;
  const visited = new Set<string>([visitKey(start, chain.start)]);
  let frontier: Array<{ node: NodeId; state: S }> = [{ node: start, state: chain.start }];
  let depth = 0;

  while (frontier.length && depth < maxDepth) {
    const next: Array<{ node: NodeId; state: S }> = [];
    for (const { node, state } of frontier) {
      onExpand?.(node, state);
      const edges = direction === 'down' ? edgesOf(space, node) : edgesInto(space, node);
      for (const edge of edges) {
        if (allowed && !allowed.has(edge.kind)) continue;
        const stepped = chain.step(state, edge.kind);
        if (!stepped) continue; // the chain does not compose — stop here, don't lie
        const target = direction === 'down' ? edge.child : edge.parent;
        if (stepped.reached && target !== start) out.add(target);
        if (!stepped.extends) continue;
        const k = visitKey(target, stepped.state);
        if (visited.has(k)) continue;
        visited.add(k);
        next.push({ node: target, state: stepped.state });
      }
    }
    frontier = next;
    depth += 1;
  }
  return out;
}

/**
 * The group ids to filter on, to get "everything in `group`, including its subgroups".
 *
 * This is the read path in one function, and it is why we need **no new filter operator**: expand
 * the group into its descendant set, then hand that set to the existing `arrayContainsAny` — which
 * maps to Postgres `&&`, PostgREST `ov`, and Dexie `anyOf` with zero new machinery.
 *
 * @example
 * const ids = closureIds(space, animal);          // ['animal', 'dog', 'poodle', ...]
 * provider.getList({ filter: { field: 'groups', operator: 'arrayContainsAny', value: ids } });
 */
export function closureIds(space: GroupSpace, group: NodeId, options: WalkOptions = {}): NodeId[] {
  return [group, ...descendants(space, group, options)];
}

/**
 * All the members of a group.
 *
 * `expand: 'direct'` — only what is immediately in it.
 * `expand: 'closure'` — what is directly in it, plus everything below it that `descendants` reaches,
 *   de-duplicated. The kind of each member's OWN edge counts (`closureScope`): with `wheel part_of
 *   car` and `car is_a vehicle`, `wheel` is in `car` but not in `vehicle`. A member of a subgroup
 *   by a non-transitive edge (`instance_of`) is not a member of the group above it either, exactly
 *   as `descendants` and `ancestors` say.
 *
 * This flag is Zotero's `View → Show Items from Subcollections`, and exposing it as a *view*
 * parameter rather than baking one answer into the model is the clearest single demonstration of
 * the thesis: the same edges, two hierarchies, one checkbox.
 */
export function membersOf(
  space: GroupSpace,
  group: NodeId,
  options: WalkOptions & { readonly expand?: 'direct' | 'closure'; readonly itemsOnly?: boolean } = {},
): NodeId[] {
  const { expand = 'direct', itemsOnly = false } = options;
  // Each group the members may sit in, with the kinds their own edge may have (`null`: any kind).
  const scope: Map<NodeId, ReadonlySet<EdgeKind> | null> =
    expand === 'closure' ? new Map(closureScope(space, group, options)) : new Map();
  scope.set(group, null); // the direct members, by any kind, as in `expand: 'direct'`

  const out = new Set<NodeId>();
  for (const [g, kinds] of scope) {
    for (const edge of edgesOf(space, g)) {
      if (options.kinds && !options.kinds.includes(edge.kind)) continue;
      if (kinds && !kinds.has(edge.kind)) continue;
      if (itemsOnly && (space.forward.get(edge.child)?.size ?? 0) > 0) continue;
      out.add(edge.child);
    }
  }
  // A group is not a member of itself, even when it is reachable from itself via the closure set.
  out.delete(group);
  return [...out];
}

/**
 * How many things are in this group?
 *
 * Always a **de-duplicated union over the closure**, never `Σ children.count`. The naive rollup is
 * *wrong* under polyhierarchy rather than merely broken — an item reachable through two subgroups
 * would be counted twice — and wrong-but-plausible numbers are worse than an obvious failure.
 * (Solr's documented default for multivalued fields does exactly this double-counting.)
 */
export function countIn(
  space: GroupSpace,
  group: NodeId,
  options: WalkOptions & { readonly expand?: 'direct' | 'closure'; readonly itemsOnly?: boolean } = {},
): number {
  return membersOf(space, group, { itemsOnly: true, ...options }).length;
}

/** Is `descendant` inside `group`, at any depth? */
export const isWithin = (space: GroupSpace, descendant: NodeId, group: NodeId): boolean =>
  descendants(space, group).has(descendant);

/**
 * Every cycle currently present in the space.
 *
 * `applyDelta` refuses to create cycles, so this should return `[]` for any space we built. It
 * exists for the data we *didn't* build: imports, foreign store adapters, and hand-edited files.
 * Real taxonomies do contain cycles — a study of the Open Directory Project found its symbolic
 * links "by inducing cycles, preclude the underlying graph model from being a DAG", and Wikipedia's
 * category graph has them too.
 */
export function detectCycles(space: GroupSpace): NodeId[][] {
  const cycles: NodeId[][] = [];
  const colour = new Map<NodeId, 'grey' | 'black'>();

  const visit = (node: NodeId, path: NodeId[]): void => {
    const c = colour.get(node);
    if (c === 'black') return;
    if (c === 'grey') {
      const start = path.indexOf(node);
      if (start !== -1) cycles.push([...path.slice(start), node]);
      return;
    }
    colour.set(node, 'grey');
    for (const edge of edgesOf(space, node)) {
      if (!isAcyclicKind(space.profile, edge.kind)) continue; // the same kinds the write path keeps acyclic
      visit(edge.child, [...path, node]);
    }
    colour.set(node, 'black');
  };

  for (const id of space.nodes.keys()) visit(id, []);
  return cycles;
}
