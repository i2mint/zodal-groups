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

import type { GroupSpace, NodeId } from './../model.js';
import { closureIds, descendants } from './../closure.js';
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
 * on the item row (as an indexed set, for `arrayContainsAny`).
 */
export function groupsOfItem<P>(space: GroupSpace<P>, item: NodeId, expand: 'direct' | 'closure' = 'closure'): Set<NodeId> {
  const direct = edgesInto(space, item)
    .filter((e) => space.profile.edgeKinds[e.kind]?.transitive)
    .map((e) => e.parent);
  if (expand === 'direct') return new Set(direct);

  const out = new Set<NodeId>(direct);
  for (const g of direct) {
    // Walk *up* from each direct group: an item in `poodle` is also in `dog` and `animal`.
    for (const ancestor of ancestorsOf(space, g)) out.add(ancestor);
  }
  return out;
}

function ancestorsOf<P>(space: GroupSpace<P>, node: NodeId): Set<NodeId> {
  const out = new Set<NodeId>();
  const stack = [node];
  const seen = new Set<NodeId>([node]);
  while (stack.length) {
    const current = stack.pop()!;
    for (const edge of edgesInto(space, current)) {
      if (!space.profile.edgeKinds[edge.kind]?.transitive) continue;
      if (seen.has(edge.parent)) continue;
      seen.add(edge.parent);
      out.add(edge.parent);
      stack.push(edge.parent);
    }
  }
  return out;
}

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

  // Expand every selected group to its closure once, then test membership.
  const expanded = new Set<NodeId>();
  for (const g of groups) for (const id of closureIds(space, g)) expanded.add(id);

  return new Set(
    pool.filter((item) => {
      for (const g of groupsOfItem(space, item, 'direct')) {
        if (expanded.has(g)) return true;
      }
      return false;
    }),
  );
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

  const candidates = under
    ? edgesOf(space, under)
        .filter((e) => space.profile.edgeKinds[e.kind]?.transitive)
        .map((e) => e.child)
        .filter((id) => isGroup(space, id))
    : [...space.nodes.keys()].filter((id) => isGroup(space, id) && !edgesInto(space, id).length);

  // The pool this facet is counted against: everything matching the *other* selections.
  const others = new Set([...selected].filter((g) => !candidates.includes(g)));
  const pool = others.size ? [...matchingItems(space, others, items)] : items;

  const out: FacetValue[] = [];
  for (const group of candidates) {
    const scope = expand === 'closure' ? new Set(closureIds(space, group)) : new Set([group]);
    // A de-duplicated set, not a running total. This is the whole point.
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
