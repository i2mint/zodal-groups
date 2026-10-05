/**
 * Per-family cardinality — "at most N values of this family per item".
 *
 * A profile's cardinalities are global (`maxGroupsPerItem` caps *all* of an item's memberships). A
 * board over a tag family needs a local one: Linear allows "only one label from a given label
 * group", and a status column is exactly that. Here a node that roots a family carries a
 * `FamilyRule` (`Node.family`); the family's **values** are its direct subgroups (through transitive
 * edge kinds); and an item **falls under** a value when the value is among its ancestors.
 *
 * Counting branches rather than edges is the point: an item filed in `Done` and in `Done/Archived`
 * falls under one value of `Status`, so a board puts it in one column, and the rule lets it through.
 * An item that reaches two values — directly, or through a subgroup that polyhierarchy filed under
 * both — would sit in two columns, and is refused with a `maxPerFamily` violation naming the family
 * and the values.
 *
 * The check is a property of the delta's END state, so it runs after the structural checks in
 * `applyDelta`, over only the items the delta could have moved: the children of added edges, the
 * items below an added group edge, and the items below a node whose rule the delta sets.
 *
 * @see `docs/research/_reconciliation.md` — D26.
 */

import type { EdgeDelta, GroupSpace, NodeId, Violation } from './model.js';
import { ancestors, descendants } from './closure.js';
import { edgesOf, isGroup } from './space.js';

/** Does `group` or anything above it root a family? Cheap pre-check before the full rule check. */
export function hasFamilyAtOrAbove(space: GroupSpace, group: NodeId): boolean {
  if (space.nodes.get(group)?.family) return true;
  for (const a of ancestors(space, group)) if (space.nodes.get(a)?.family) return true;
  return false;
}

/**
 * The values of `family` that `item` falls under. Values are the family's direct subgroups through
 * transitive edge kinds; "falls under" uses the same kind-aware closure as everything else.
 */
export function familyValuesOf(space: GroupSpace, family: NodeId, item: NodeId): NodeId[] {
  const above = ancestors(space, item);
  const values = new Set<NodeId>();
  for (const edge of edgesOf(space, family)) {
    if (!space.profile.edgeKinds[edge.kind]?.transitive) continue;
    if (above.has(edge.child)) values.add(edge.child);
  }
  return [...values];
}

/**
 * Every family rule broken, after `delta`, by an item the delta could have affected. `space` is the
 * delta's end state.
 */
export function familyViolations(space: GroupSpace, delta: EdgeDelta): Violation[] {
  const items = new Set<NodeId>();
  const itemsUnder = (group: NodeId): void => {
    for (const d of descendants(space, group)) if (!isGroup(space, d)) items.add(d);
  };

  for (const edge of delta.added ?? []) {
    if (!space.edges.has(edge.id)) continue;
    if (!hasFamilyAtOrAbove(space, edge.parent)) continue;
    if (isGroup(space, edge.child)) itemsUnder(edge.child);
    else items.add(edge.child);
  }
  for (const node of delta.upsertNodes ?? []) {
    if (node.family && space.nodes.has(node.id)) itemsUnder(node.id);
  }
  if (!items.size) return [];

  const addedInto = new Map((delta.added ?? []).map((e) => [e.child, e] as const));
  const out: Violation[] = [];
  for (const item of items) {
    for (const family of ancestors(space, item)) {
      const rule = space.nodes.get(family)?.family;
      if (!rule) continue;
      const values = familyValuesOf(space, family, item);
      if (values.length <= rule.maxPerItem) continue;
      const edge = addedInto.get(item);
      out.push({
        code: 'maxPerFamily',
        message:
          `${item} would fall under ${values.length} values of family '${family}' ` +
          `(${values.join(', ')}); '${family}' allows ${rule.maxPerItem} per item` +
          (rule.maxPerItem === 1 ? ' (it is exclusive).' : '.'),
        family,
        node: item,
        values,
        ...(edge ? { edge } : {}),
      });
    }
  }
  return out;
}
