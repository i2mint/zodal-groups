/**
 * Faceted browsing — counts, drill-down, and the filter that scopes a search to a subtree.
 *
 * Two rules govern this module, and everyone gets both wrong once.
 *
 * **1. Within a facet, selections are OR. Across facets, they are AND.** Hearst's formulation is
 * "a conjunct of disjuncts", and selecting a hierarchical label means "a disjunction over all the
 * labels beneath it" — i.e. picking `animal` must match items tagged only `poodle`. That is what
 * `closureIds` gives us, and it is the entire reason the closure engine exists.
 *
 * **2. Counts are a de-duplicated union over the closure — never a sum of child counts.** Under
 * polyhierarchy an item can reach a group through two different subgroups, so `Σ children.count`
 * double-counts it. This is Solr's documented default behaviour for multivalued fields, and it is
 * the worst class of bug: the number is *wrong*, not *broken*, so nobody notices for a year. We
 * count over item **sets**, which makes double-counting structurally unrepresentable.
 *
 * A sharp edge worth knowing before you build a facet panel: **correct *disjunctive* facet counts
 * require N+1 queries** — one per selected facet, with that facet's own filter removed, or the
 * counts for the options you did *not* pick all collapse to zero and the panel becomes a dead end.
 * Meilisearch, Solr (`excludeTags`) and Algolia all confirm this is architectural, not a flag. When
 * counting client-side (below) we simply do the same thing in a loop.
 *
 * @see `docs/research/_reconciliation.md` — D17, §6.
 */

import type { EdgeKind, GroupSpace, NodeId } from './../model.js';
import { ancestors, closureScope, descendants } from './../closure.js';
import { edgesInto, edgesOf, isGroup } from './../space.js';

/** One row in a facet panel. */
export interface FacetValue {
  readonly group: NodeId;
  readonly label: string;
  /** De-duplicated count over the closure. Never a sum of children. */
  readonly count: number;
  readonly selected: boolean;
  /** Has subgroups — can be drilled into. */
  readonly hasChildren: boolean;
  readonly depth: number;
}

export interface FacetOptions {
  /** The item set to count over. Defaults to every non-group node in the space. */
  readonly items?: Iterable<NodeId>;
  /** Currently-selected groups (a disjunction — see rule 1). */
  readonly selected?: ReadonlySet<NodeId>;
  /** Count items in subgroups too. Defaults to `true`, which is what users expect from a facet. */
  readonly expand?: 'direct' | 'closure';
  /** Never show a facet that would lead to zero results — Flamenco's core invariant. */
  readonly hideEmpty?: boolean;
  /** Which groups to offer. Defaults to the children of `under`, or the roots. */
  readonly under?: NodeId;
}

/**
 * The groups an item belongs to, transitively — the item's "facet values".
 *
 * This is the inverse index plus closure, and it is what a search backend would store denormalized
 * on the item row (as an indexed set, for `arrayContainsAny`). `'closure'` is exactly
 * `ancestors(space, item)`: the walk composes edge kinds from the item's own edge up, so with
 * `wheel part_of car is_a vehicle` the wheel is in `car`, not in `vehicle`.
 */
export function groupsOfItem<P>(space: GroupSpace<P>, item: NodeId, expand: 'direct' | 'closure' = 'closure'): Set<NodeId> {
  if (expand === 'closure') return ancestors(space, item);
  return new Set(
    edgesInto(space, item)
      .filter((e) => space.profile.edgeKinds[e.kind]?.transitive)
      .map((e) => e.parent),
  );
}

/** Does one of the item's own edges land in the scope, with a kind the scope accepts there? */
const inScope = <P>(space: GroupSpace<P>, item: NodeId, scope: ReadonlyMap<NodeId, ReadonlySet<EdgeKind>>): boolean =>
  edgesInto(space, item).some((e) => scope.get(e.parent)?.has(e.kind) === true);

/** Every non-group node. */
export const allItems = <P>(space: GroupSpace<P>): NodeId[] =>
  [...space.nodes.keys()].filter((id) => !isGroup(space, id));

/**
 * Which items match the current selection?
 *
 * Within-facet OR: an item matches a selected group if it is in that group *or any of its
 * descendants*. Across selections, this function ANDs (pass one call per facet and intersect, or
 * use `facetPanel` which does it for you).
 */
export function matchingItems<P>(
  space: GroupSpace<P>,
  selected: Iterable<NodeId>,
  items: Iterable<NodeId> = allItems(space),
): Set<NodeId> {
  const groups = [...selected];
  const pool = [...items];
  if (!groups.length) return new Set(pool);

  // Expand every selected group to its closure scope once (each group with the item-edge kinds that
  // reach the selection through it), then test each item's own edges.
  const scope = new Map<NodeId, Set<EdgeKind>>();
  for (const g of groups) {
    for (const [id, kinds] of closureScope(space, g)) {
      const set = scope.get(id);
      if (set) for (const k of kinds) set.add(k);
      else scope.set(id, new Set(kinds));
    }
  }

  return new Set(pool.filter((item) => inScope(space, item, scope)));
}

/**
 * Build a facet panel.
 *
 * Counts are computed against the item pool *after* applying the other facets' selections but
 * **not this facet's own** — the N+1 rule from the module docstring. Skip it and every unselected
 * option reads zero, which turns the panel into a dead end.
 */
export function facetPanel<P>(space: GroupSpace<P>, options: FacetOptions = {}): FacetValue[] {
  const {
    selected = new Set<NodeId>(),
    expand = 'closure',
    hideEmpty = true,
    under,
  } = options;
  const items = [...(options.items ?? allItems(space))];

  // A set: two edges of different kinds from `under` to one child must not make two rows.
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

  // The pool this facet is counted against: everything matching the *other* selections.
  const offered = new Set(candidates);
  const others = new Set([...selected].filter((g) => !offered.has(g)));
  // A set: the per-item stamp below de-duplicates an item only against itself, not a repeat of it.
  const pool = others.size ? matchingItems(space, others, items) : new Set(items);

  // One pass over the pool, not one per candidate (that was O(values × items): ~600 ms for four
  // panels over 650 items). Invert each candidate's scope once — "which candidates does a direct
  // group count towards?" — so each item costs O(its direct groups). The scope is still each
  // candidate's own closure scope, walked *down* with its edge-kind composition, and the item's own
  // edge kind must compose with it too: the count is exactly `descendants(candidate) ∩ pool`.
  const transitiveKinds = new Set(Object.keys(space.profile.edgeKinds).filter((k) => space.profile.edgeKinds[k]?.transitive));
  const countsTowards = new Map<NodeId, Array<{ readonly group: NodeId; readonly kinds: ReadonlySet<EdgeKind> }>>();
  for (const group of candidates) {
    const scope = expand === 'closure' ? closureScope(space, group) : new Map([[group, transitiveKinds]]);
    for (const [g, kinds] of scope) {
      const list = countsTowards.get(g);
      if (list) list.push({ group, kinds });
      else countsTowards.set(g, [{ group, kinds }]);
    }
  }

  // A de-duplicated set per candidate, not a running total: an item reaching a candidate through
  // two subgroups is stamped once. This is the whole point.
  const counts = new Map<NodeId, number>();
  const lastCounted = new Map<NodeId, NodeId>();
  for (const item of pool) {
    for (const e of edgesInto(space, item)) {
      for (const { group, kinds } of countsTowards.get(e.parent) ?? []) {
        if (!kinds.has(e.kind) || lastCounted.get(group) === item) continue;
        lastCounted.set(group, item);
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }
    }
  }

  const out: FacetValue[] = [];
  for (const group of candidates) {
    const count = counts.get(group) ?? 0;
    if (hideEmpty && count === 0 && !selected.has(group)) continue;

    out.push({
      group,
      label: space.nodes.get(group)?.label ?? group,
      count,
      selected: selected.has(group),
      // `descendants(group)` is non-empty exactly when some edge out of it is of a transitive kind.
      hasChildren: edgesOf(space, group).some(
        (e) => e.child !== group && space.profile.edgeKinds[e.kind]?.transitive,
      ),
      depth: 0,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The filter to hand a `DataProvider` to scope a query to a group *and its subgroups*.
 *
 * This is the bridge back to `@zodal/store`, and the reason we needed **no new filter operator**:
 * we expand the group into its descendant set here, and the existing `arrayContainsAny` does the
 * rest — mapping to Postgres `&&`, PostgREST `ov`, and Dexie `anyOf` with zero new machinery.
 *
 * @example
 * const filter = scopeFilter(space, animal, { field: 'groups' });
 * // → { field: 'groups', operator: 'arrayContainsAny', value: ['animal','dog','poodle'] }
 * provider.getList({ filter });
 *
 * **Mixed edge kinds.** The item's indexed field holds group ids, not the kinds of its edges, so on a
 * profile with several transitive kinds that do not all compose (`thesaurus`) this over-matches:
 * `wheel part_of car is_a vehicle` puts `car` in `vehicle`'s scope, and the wheel's `['car']`
 * matches, though `descendants(vehicle)` has no wheel. Single-kind spaces are exact. For exact
 * scoping on a mixed-kind space, index each item's direct groups plus its closure instead
 * (`groupsOfItem(…, 'closure')` composes kinds from the item up, but has no group the item is in by
 * a non-transitive kind such as `instance_of`, so the direct ones are added) and filter with
 * `expand: 'direct'`:
 *
 * @example
 * // on write:
 * record.groups = [...new Set([...groupsOfItem(space, item, 'direct'), ...groupsOfItem(space, item, 'closure')])];
 * provider.getList({ filter: scopeFilter(space, vehicle, { expand: 'direct' }) });
 */
export function scopeFilter<P>(
  space: GroupSpace<P>,
  group: NodeId,
  options: { readonly field?: string; readonly expand?: 'direct' | 'closure' } = {},
): { field: string; operator: 'arrayContainsAny'; value: NodeId[] } {
  const { field = 'groups', expand = 'closure' } = options;
  // Only *groups* go in the filter: the item's indexed field holds the group ids it belongs to, so
  // including descendant items would be a category error (and would match nothing).
  const value =
    expand === 'closure'
      ? [group, ...[...descendants(space, group)].filter((id) => isGroup(space, id))]
      : [group];
  return { field, operator: 'arrayContainsAny', value };
}
