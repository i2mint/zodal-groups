/**
 * Structural lints for a group space.
 *
 * Every rule here is empirically motivated rather than invented: the set is derived from qSKOS, a
 * quality-assessment tool for SKOS vocabularies, whose issue list came from surveying real,
 * published thesauri and finding what actually goes wrong in them. Z39.19 contributes the
 * partitive-edge rule.
 *
 * These are *lints*, not invariants: `applyDelta` refuses to create cycles, but everything below is
 * a smell rather than a violation, and a healthy taxonomy may legitimately trip several. Run them
 * after an import, or in a taxonomy-editing UI, and show them as warnings.
 */

import type { GroupSpace, NodeId } from './model.js';
import { detectCycles } from './closure.js';
import { edgesInto, edgesOf, isGroup } from './space.js';

export interface Lint {
  readonly rule:
    | 'cycle'
    | 'orphanGroup'
    | 'emptyGroup'
    | 'disconnectedCluster'
    | 'redundantEdge'
    | 'multiParentPartitive'
    | 'singleChildGroup';
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly nodes: readonly NodeId[];
}

/** Run every lint. */
export function lint<P>(space: GroupSpace<P>): Lint[] {
  return [
    ...cycleLints(space),
    ...orphanGroupLints(space),
    ...emptyGroupLints(space),
    ...redundantEdgeLints(space),
    ...multiParentPartitiveLints(space),
  ];
}

/** A cycle. Never creatable through `applyDelta` — but imports and foreign adapters produce them. */
function cycleLints<P>(space: GroupSpace<P>): Lint[] {
  return detectCycles(space).map((path) => ({
    rule: 'cycle' as const,
    severity: 'error' as const,
    message: `Cycle: ${path.join(' → ')}. Closure and counts are undefined until this is broken.`,
    nodes: path,
  }));
}

/** A group with no parent and no children — floating, unreachable by browsing. */
function orphanGroupLints<P>(space: GroupSpace<P>): Lint[] {
  const out: Lint[] = [];
  for (const id of space.nodes.keys()) {
    const hasParents = (space.inverse.get(id)?.size ?? 0) > 0;
    const hasChildren = (space.forward.get(id)?.size ?? 0) > 0;
    if (!hasParents && !hasChildren) {
      out.push({
        rule: 'orphanGroup',
        severity: 'info',
        message: `'${label(space, id)}' is in no group and contains nothing.`,
        nodes: [id],
      });
    }
  }
  return out;
}

/** A group nobody is in. Fine while authoring; a dead end when browsing. */
function emptyGroupLints<P>(space: GroupSpace<P>): Lint[] {
  const out: Lint[] = [];
  for (const id of space.nodes.keys()) {
    const hasParents = (space.inverse.get(id)?.size ?? 0) > 0;
    if (hasParents && !isGroup(space, id)) continue; // an ordinary item, not an empty group
    if (!hasParents) continue;
    if ((space.forward.get(id)?.size ?? 0) === 0) {
      out.push({
        rule: 'emptyGroup',
        severity: 'warning',
        message: `'${label(space, id)}' is empty — browsing to it yields nothing.`,
        nodes: [id],
      });
    }
  }
  return out;
}

/**
 * A direct edge that duplicates a path already implied by the closure.
 *
 * If `poodle` is in `dog` and `dog` is in `animal`, then an explicit `poodle → animal` edge adds
 * nothing but does add a maintenance hazard: re-parent `dog` and the shortcut silently disagrees
 * with the tree walk. This is precisely the trap MeSH fell into, and their own docs warn about it.
 */
function redundantEdgeLints<P>(space: GroupSpace<P>): Lint[] {
  const out: Lint[] = [];
  for (const edge of space.edges.values()) {
    if (!space.profile.edgeKinds[edge.kind]?.transitive) continue;
    // Is `child` reachable from `parent` *without* using this edge?
    const seen = new Set<NodeId>([edge.parent]);
    const stack = edgesOf(space, edge.parent)
      .filter((e) => e.id !== edge.id && space.profile.edgeKinds[e.kind]?.transitive)
      .map((e) => e.child);

    let redundant = false;
    while (stack.length) {
      const current = stack.pop()!;
      if (current === edge.child) {
        redundant = true;
        break;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      for (const e of edgesOf(space, current)) {
        if (space.profile.edgeKinds[e.kind]?.transitive) stack.push(e.child);
      }
    }

    if (redundant) {
      out.push({
        rule: 'redundantEdge',
        severity: 'warning',
        message: `'${label(space, edge.child)}' is already inside '${label(space, edge.parent)}' via a longer path; the direct edge is redundant and will drift if the hierarchy is re-parented.`,
        nodes: [edge.parent, edge.child],
      });
    }
  }
  return out;
}

/**
 * A `part_of` child with several parents.
 *
 * Z39.19 (§8.3.3.2) treats whole–part relationships as exclusive: a given part belongs to one
 * whole. When it doesn't, the guidance is to demote the edge to an associative (`related`) one
 * rather than pretend the hierarchy is sound.
 */
function multiParentPartitiveLints<P>(space: GroupSpace<P>): Lint[] {
  const out: Lint[] = [];
  for (const id of space.nodes.keys()) {
    const partitive = edgesInto(space, id).filter((e) => e.kind === 'part_of');
    if (partitive.length > 1) {
      out.push({
        rule: 'multiParentPartitive',
        severity: 'warning',
        message: `'${label(space, id)}' is 'part_of' ${partitive.length} wholes. Whole–part relations are normally exclusive (Z39.19 §8.3.3.2) — consider 'related' for the extra edges.`,
        nodes: [id, ...partitive.map((e) => e.parent)],
      });
    }
  }
  return out;
}

const label = <P>(space: GroupSpace<P>, id: NodeId): string => space.nodes.get(id)?.label ?? id;
