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
 * @see `docs/research/_reconciliation.md` — D21.
 */

import type { GroupSpace, Node, NodeId } from './model.js';
import { isGroup } from './space.js';
import { allItems } from './projections/facets.js';

/** A predicate over an item, given the space it lives in. */
export type GroupRule<P = unknown> = (item: Node<P>, space: GroupSpace<P>) => boolean;

/** A group whose members are computed. */
export interface IntensionalGroup<P = unknown> {
  readonly id: NodeId;
  readonly label: string;
  readonly rule: GroupRule<P>;
}

/**
 * The computed extent of an intensional group.
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
  rule: (item, space) => !space.inverse.has(item.id) && !isGroup(space, item.id),
});

/** Items in more than one group — the polyhierarchy-specific "show me the shared things" view. */
export const multiHomed = <P>(id: NodeId, label = 'In multiple groups'): IntensionalGroup<P> => ({
  id,
  label,
  rule: (item, space) => (space.inverse.get(item.id)?.size ?? 0) > 1,
});

/** Build a smart group from a plain predicate over the payload. */
export function smartGroup<P>(
  id: NodeId,
  label: string,
  predicate: (payload: P | undefined) => boolean,
): IntensionalGroup<P> {
  return { id, label, rule: (item) => predicate(item.payload) };
}
