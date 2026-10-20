/**
 * Intensional ("smart") groups — a group defined by a predicate rather than by a member list.
 *
 * Datalog's vocabulary is the precise one and we use it: an **extensional** group is *asserted* (an
 * explicit set of membership edges — the EDB), while an **intensional** group is *derived* (a rule
 * whose extent is computed — the IDB). Saved searches, smart folders, smart playlists, Gmail
 * filters, and Zotero's "Unfiled Items" are all intensional groups, and the interesting thing about
 * them is that users do not experience them as a different *kind* of thing. A smart folder sits in
 * the sidebar next to a real one, and you drag things onto both.
 *
 * So: **an intensional group is a first-class object** — nameable, nestable, orderable, and
 * appearing in every projection alongside extensional groups — even though its *extent* is computed
 * on read rather than stored. The `.savedSearch` file is what this gets right.
 *
 * **v1 restriction: intensional groups are leaf-only.** A rule may not select over another rule's
 * output. Lifting that restriction means implementing recursive Datalog with stratified negation and
 * a fixpoint evaluator, and that is a research project rather than a feature. The restriction is
 * enforced by `defineGroups`, and it is the single place where we chose "possible later" over
 * "possible now".
 *
 * **Fluid groups (D36).** A smart group can be edited by hand without giving up its rule: an item
 * is **pinned** by an ordinary membership edge into the group's node, and **excluded** by an edge of
 * the built-in non-membership kind `excludes`. The extent is `rule(items) ∪ pinned \ excluded`
 * (`fluidExtent`). Both are edges, so every `GroupStore` persists them, `invert` undoes them, and
 * the projections show the pinned members like any others. A rule that must persist lives on the
 * node (`Node.rule`, a `FilterExpression` that `@zodal/groups-collection` evaluates), which makes
 * the node a group even before anything is pinned (`isGroup`). The predicate form here stays as the
 * in-memory escape hatch: `fluidExtent(space, id, extentOf(space, group))` applies the same edits.
 *
 * @see `docs/research/_reconciliation.md` — D21, D36.
 */

import type { EdgeKind, GroupSpace, Node, NodeId } from './model.js';
import { edgesInto, edgesOf, isAliasName, isGroup, isMembershipKind, membershipParentCount } from './space.js';
import { allItems } from './projections/facets.js';
import { compareOrder } from './order.js';

/** A predicate over an item, given the space it lives in. */
export type GroupRule<P = unknown> = (item: Node<P>, space: GroupSpace<P>) => boolean;

/** A group whose members are computed. */
export interface IntensionalGroup<P = unknown> {
  readonly id: NodeId;
  readonly label: string;
  readonly rule: GroupRule<P>;
}

/** The edge kind that keeps an item out of a smart group (`group excludes item`). */
export const EXCLUDES: EdgeKind = 'excludes';

/**
 * The members pinned into `group` by hand: the children of its membership edges, ranked ones in
 * rank order (an `ordered` space: `tag` and `moveInGroup` keep the ranks), then the rest in edge order.
 */
export function pinnedOf<P>(space: GroupSpace<P>, group: NodeId): NodeId[] {
  const pins = edgesOf(space, group).filter((e) => isMembershipKind(space.profile, e.kind));
  return [...new Set(pins.sort((a, b) => compareOrder(a.order, b.order)).map((e) => e.child))];
}

/** The items `group` keeps out by hand: the children of its `excludes` edges. */
export function excludedOf<P>(space: GroupSpace<P>, group: NodeId): NodeId[] {
  return [...new Set(edgesOf(space, group).filter((e) => e.kind === EXCLUDES).map((e) => e.child))];
}

/** Is `item` kept out of `group` by an `excludes` edge? */
export const isExcluded = <P>(space: GroupSpace<P>, group: NodeId, item: NodeId): boolean =>
  edgesInto(space, item).some((e) => e.parent === group && e.kind === EXCLUDES);

/**
 * A fluid group's extent: the items its rule selected (`matches`, in their order), then its pinned
 * members not already there, minus the items it excludes. An exclusion wins over a rule match; a
 * pin and an exclusion cannot co-exist (`excludes` is disjoint with every membership kind).
 *
 * In an **ordered** space only pins carry a rank (D37), so the pins come FIRST, in rank order, and
 * the unpinned matches follow in `matches` order: a pin the rule also matches sits at its rank, and
 * `moveInGroup` visibly reorders it. To place a matched item, pin it (`tag`), then move it.
 */
export function fluidExtent<P>(space: GroupSpace<P>, group: NodeId, matches: Iterable<NodeId>): NodeId[] {
  const excluded = new Set(excludedOf(space, group));
  const pins = pinnedOf(space, group);
  const out = new Set<NodeId>();
  const sources = space.profile.ordered ? [pins, matches] : [matches, pins];
  for (const source of sources) for (const id of source) if (!excluded.has(id)) out.add(id);
  return [...out];
}

/**
 * The computed extent of an intensional group: the items in `items` its predicate selects. For a
 * fluid group, edit it by hand with `fluidExtent(space, node, extentOf(space, group, items))`.
 *
 * Re-evaluated on read. There is no invalidation machinery and deliberately so: the item pool is
 * the expensive thing to iterate, and a host that cares can memoize on `space.revision`, which is
 * exactly what it is for.
 */
export function extentOf<P>(
  space: GroupSpace<P>,
  group: IntensionalGroup<P>,
  items: Iterable<NodeId> = allItems(space),
): NodeId[] {
  const out: NodeId[] = [];
  for (const id of items) {
    const node = space.nodes.get(id);
    if (!node) continue;
    if (group.rule(node, space)) out.push(id);
  }
  return out;
}

// ── the built-in smart groups every product ends up needing ─────────────────

/**
 * Items in no group at all — Zotero's **Unfiled Items**.
 *
 * Worth shipping as a built-in because the alternative (Gmail's implicit universal "All Mail"
 * group, which an item can never leave) hides the orphan case rather than surfacing it, and an item
 * that has silently fallen out of every group is precisely the thing a user needs to be shown.
 */
export const unfiled = <P>(id: NodeId, label = 'Unfiled'): IntensionalGroup<P> => ({
  id,
  label,
  // The same reading as `orphansOf` (D35): a `related` or `alias_of` link files nothing.
  rule: (item, space) => membershipParentCount(space, item.id) === 0 && !isGroup(space, item.id) && !isAliasName(space, item.id),
});

/** Items in more than one group — the polyhierarchy-specific "show me the shared things" view. */
export const multiHomed = <P>(id: NodeId, label = 'In multiple groups'): IntensionalGroup<P> => ({
  id,
  label,
  rule: (item, space) => membershipParentCount(space, item.id) > 1,
});

/** Build a smart group from a plain predicate over the payload. */
export function smartGroup<P>(
  id: NodeId,
  label: string,
  predicate: (payload: P | undefined) => boolean,
): IntensionalGroup<P> {
  return { id, label, rule: (item) => predicate(item.payload) };
}
