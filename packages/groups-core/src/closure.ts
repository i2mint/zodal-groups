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
 * double-counts. Every function here memoizes on node id and guards against revisits — including
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
import { edgesInto, edgesOf } from './space.js';

/** Does a chain arriving as `carried` extend through an edge of kind `next`? */
function compose(profile: GroupProfile, carried: EdgeKind | null, next: EdgeKind): EdgeKind | null {
  const def = profile.edgeKinds[next];
  if (!def?.transitive) return null;
  if (carried === null) return next; // first hop
  const carriedDef = profile.edgeKinds[carried];
  if (!carriedDef?.transitive) return null;
  // With no declared composition, a chain only continues through the *same* kind. This is the
  // conservative reading, and it is the one that keeps `part_of ∘ is_a` from concluding nonsense.
  if (!carriedDef.composesWith) return carried === next ? carried : null;
  return carriedDef.composesWith[next] ?? null;
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

function walk(
  space: GroupSpace,
  start: NodeId,
  direction: 'up' | 'down',
  options: WalkOptions,
): Set<NodeId> {
  const out = new Set<NodeId>();
  const allowed = options.kinds ? new Set(options.kinds) : null;
  const maxDepth = options.maxDepth ?? Infinity;

  // `visited` is keyed by node — memoization, and the cycle guard, in one.
  const visited = new Set<NodeId>([start]);
  let frontier: Array<{ node: NodeId; carried: EdgeKind | null }> = [{ node: start, carried: null }];
  let depth = 0;

  while (frontier.length && depth < maxDepth) {
    const next: Array<{ node: NodeId; carried: EdgeKind | null }> = [];
    for (const { node, carried } of frontier) {
      const edges = direction === 'down' ? edgesOf(space, node) : edgesInto(space, node);
      for (const edge of edges) {
        if (allowed && !allowed.has(edge.kind)) continue;
        const composed = compose(space.profile, carried, edge.kind);
        if (composed === null) continue; // the chain does not compose — stop here, don't lie
        const target = direction === 'down' ? edge.child : edge.parent;
        if (visited.has(target)) continue;
        visited.add(target);
        out.add(target);
        next.push({ node: target, carried: composed });
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
 * `expand: 'closure'` — everything in it or in any subgroup, de-duplicated.
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
  const groups = expand === 'closure' ? closureIds(space, group, options) : [group];

  const out = new Set<NodeId>();
  for (const g of groups) {
    for (const edge of edgesOf(space, g)) {
      if (options.kinds && !options.kinds.includes(edge.kind)) continue;
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
      if (!space.profile.edgeKinds[edge.kind]?.transitive) continue;
      visit(edge.child, [...path, node]);
    }
    colour.set(node, 'black');
  };

  for (const id of space.nodes.keys()) visit(id, []);
  return cycles;
}
