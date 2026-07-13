/**
 * The space: index maintenance, the single write primitive, and invariant enforcement.
 *
 * `applyDelta` is the *only* way to change a `GroupSpace`. It validates the delta against the
 * profile, refuses cycles (reporting the offending path, never a bare boolean), updates the forward
 * and inverse indexes together, and bumps `revision`.
 *
 * Because both indexes are written in the same operation by the same writer, index drift — the
 * classic failure of keeping a "folders tree" and a "tags map" in sync with an observer — is not
 * merely unlikely here; it is unrepresentable. There is one relation. `forward` and `inverse` are
 * two views of it, and both are always live.
 *
 * @see `docs/research/_reconciliation.md` — decisions D2, D7, D8, D15.
 */

import {
  edgeId,
  type Edge,
  type EdgeDelta,
  type EdgeId,
  type GroupSpace,
  type Node,
  type NodeId,
  type Result,
  type Violation,
  CONTAINS,
} from './model.js';
import { resolveProfile, type GroupProfile, type ProfileName } from './profile.js';

// ── construction ────────────────────────────────────────────────────────────

export interface CreateSpaceOptions<P> {
  readonly profile?: ProfileName | GroupProfile;
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  readonly nodes?: readonly Node<P>[];
  readonly edges?: readonly Edge[];
}

/** An empty space under the given profile. */
export function createGroupSpace<P = unknown>(options: CreateSpaceOptions<P> = {}): GroupSpace<P> {
  const profile = resolveProfile(options.profile, options.overrides);
  const empty: GroupSpace<P> = {
    profile,
    revision: 0,
    nodes: new Map(),
    edges: new Map(),
    forward: new Map(),
    inverse: new Map(),
  };
  if (!options.nodes?.length && !options.edges?.length) return empty;

  const seeded = applyDelta(empty, {
    upsertNodes: options.nodes,
    added: options.edges,
  });
  if (!seeded.ok) {
    throw new Error(
      `Seed data violates profile '${profile.name}':\n` +
        seeded.violations.map((v) => `  - [${v.code}] ${v.message}`).join('\n'),
    );
  }
  return seeded.value;
}

// ── index helpers ───────────────────────────────────────────────────────────

function addToIndex(
  index: Map<NodeId, Set<EdgeId>>,
  key: NodeId,
  id: EdgeId,
): void {
  const existing = index.get(key);
  if (existing) existing.add(id);
  else index.set(key, new Set([id]));
}

function removeFromIndex(
  index: Map<NodeId, Set<EdgeId>>,
  key: NodeId,
  id: EdgeId,
): void {
  const existing = index.get(key);
  if (!existing) return;
  existing.delete(id);
  if (existing.size === 0) index.delete(key);
}

function cloneIndex(src: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>): Map<NodeId, Set<EdgeId>> {
  const out = new Map<NodeId, Set<EdgeId>>();
  for (const [k, v] of src) out.set(k, new Set(v));
  return out;
}

// ── reads over the indexes (the two live views) ─────────────────────────────

/** The edges out of a group — its memberships. The **groups** view. */
export function edgesOf(space: GroupSpace, parent: NodeId): Edge[] {
  const ids = space.forward.get(parent);
  if (!ids) return [];
  return [...ids].map((id) => space.edges.get(id)!).filter(Boolean);
}

/** The edges into a node — the groups it belongs to. The **tags** view. */
export function edgesInto(space: GroupSpace, child: NodeId): Edge[] {
  const ids = space.inverse.get(child);
  if (!ids) return [];
  return [...ids].map((id) => space.edges.get(id)!).filter(Boolean);
}

/** Direct members of a group. */
export const childrenOf = (space: GroupSpace, parent: NodeId): NodeId[] =>
  edgesOf(space, parent).map((e) => e.child);

/**
 * The groups a node is directly in.
 *
 * There is deliberately no `parentOf()` returning a single value: an arbitrary "primary parent" is
 * exactly the `..` ambiguity Unix refused, and it is a lie that leaks into every breadcrumb. Where
 * a single path is genuinely needed (a URL, a deep link), ask for it explicitly via
 * `primaryPath()` — which makes the choice visible.
 */
export const parentsOf = (space: GroupSpace, child: NodeId): NodeId[] =>
  edgesInto(space, child).map((e) => e.parent);

/** A node is a *group* iff something is in it. Group-ness is data, not type. */
export const isGroup = (space: GroupSpace, id: NodeId): boolean =>
  (space.forward.get(id)?.size ?? 0) > 0;

/** Nodes with no parents — the browse entry points. */
export function rootsOf(space: GroupSpace): NodeId[] {
  const roots: NodeId[] = [];
  for (const id of space.nodes.keys()) {
    if (!space.inverse.has(id)) roots.push(id);
  }
  return roots;
}

/** Nodes in no group at all — Zotero's "Unfiled Items". */
export const orphansOf = (space: GroupSpace): NodeId[] =>
  [...space.nodes.keys()].filter((id) => !space.inverse.has(id) && !isGroup(space, id));

// ── cycle detection ─────────────────────────────────────────────────────────

/**
 * Would adding `parent → child` close a cycle? Returns the offending path if so, else `null`.
 *
 * Returning the *path* rather than a boolean is not a nicety. Under polyhierarchy a cycle can close
 * through a branch the user cannot see, so "you can't drop that here" with no explanation is
 * indistinguishable from a bug. With the path, the UI can say: *"Reading is already inside
 * Archive → Research → Reading."*
 */
export function findCycle(space: GroupSpace, parent: NodeId, child: NodeId): NodeId[] | null {
  if (parent === child) return [parent, child];
  // A cycle appears iff `parent` is already reachable from `child` by walking downwards.
  const stack: Array<{ node: NodeId; path: NodeId[] }> = [{ node: child, path: [child] }];
  const seen = new Set<NodeId>([child]);

  while (stack.length) {
    const { node, path } = stack.pop()!;
    for (const edge of edgesOf(space, node)) {
      if (!isTransitiveKind(space.profile, edge.kind)) continue;
      const next = edge.child;
      if (next === parent) return [...path, parent];
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push({ node: next, path: [...path, next] });
    }
  }
  return null;
}

function isTransitiveKind(profile: GroupProfile, kind: string): boolean {
  return profile.edgeKinds[kind]?.transitive ?? false;
}

/**
 * Depth of the deepest chain of *group-in-group* nesting below `node`. Cycle-safe.
 *
 * Only edges whose child is itself a group count. `maxDepth` measures how deeply the **group
 * hierarchy** nests, not how far an item sits from a root — otherwise `maxDepth: 0` (flat tagging)
 * would forbid tagging an item at all, which is the opposite of what it means.
 */
function groupDepthBelow(space: GroupSpace, node: NodeId, seen = new Set<NodeId>()): number {
  if (seen.has(node)) return 0;
  seen.add(node);
  let deepest = 0;
  for (const edge of edgesOf(space, node)) {
    if (!isTransitiveKind(space.profile, edge.kind)) continue;
    if (!isGroup(space, edge.child)) continue; // an item is not a level of nesting
    deepest = Math.max(deepest, 1 + groupDepthBelow(space, edge.child, seen));
  }
  seen.delete(node);
  return deepest;
}

/**
 * Depth of the longest chain of nesting above `node`. Cycle-safe.
 *
 * Every node above a group is itself a group (it has children, by definition), so every edge in an
 * upward chain is group-in-group nesting and counts.
 */
function depthAbove(space: GroupSpace, node: NodeId, seen = new Set<NodeId>()): number {
  if (seen.has(node)) return 0;
  seen.add(node);
  let deepest = 0;
  for (const edge of edgesInto(space, node)) {
    if (!isTransitiveKind(space.profile, edge.kind)) continue;
    deepest = Math.max(deepest, 1 + depthAbove(space, edge.parent, seen));
  }
  seen.delete(node);
  return deepest;
}

// ── the write primitive ─────────────────────────────────────────────────────

let edgeCounter = 0;

/** Build an edge, minting an id if none is supplied. */
export function makeEdge(parent: NodeId, child: NodeId, init: Partial<Omit<Edge, 'parent' | 'child'>> = {}): Edge {
  return {
    id: init.id ?? edgeId(`e${++edgeCounter}:${parent}>${child}`),
    parent,
    child,
    kind: init.kind ?? CONTAINS,
    ...(init.label !== undefined ? { label: init.label } : {}),
    ...(init.order !== undefined ? { order: init.order } : {}),
    ...(init.meta !== undefined ? { meta: init.meta } : {}),
  };
}

/**
 * Apply a delta. The only mutation path.
 *
 * Validation is all-or-nothing: if any edge in the delta violates the profile, nothing is applied
 * and every violation is reported. Partial application would leave the caller unable to reason
 * about what happened.
 */
export function applyDelta<P>(space: GroupSpace<P>, delta: EdgeDelta): Result<GroupSpace<P>> {
  const nodes = new Map(space.nodes);
  const edges = new Map(space.edges);
  const forward = cloneIndex(space.forward);
  const inverse = cloneIndex(space.inverse);

  for (const node of delta.upsertNodes ?? []) {
    nodes.set(node.id, { ...(nodes.get(node.id) ?? {}), ...node } as Node<P>);
  }

  // Removals first: a re-parent is (remove old, add new), and doing it in this order means the old
  // edge never counts against `maxParents` when the new one is validated.
  for (const id of delta.removed ?? []) {
    const edge = edges.get(id);
    if (!edge) continue;
    edges.delete(id);
    removeFromIndex(forward, edge.parent, id);
    removeFromIndex(inverse, edge.child, id);
  }

  const staged: GroupSpace<P> = { ...space, nodes, edges, forward, inverse };
  const violations: Violation[] = [];

  for (const edge of delta.added ?? []) {
    const v = validateEdge(staged, edge);
    if (v.length) {
      violations.push(...v);
      continue;
    }
    // Auto-create referenced nodes so the simple path stays simple.
    if (!nodes.has(edge.parent)) nodes.set(edge.parent, { id: edge.parent } as Node<P>);
    if (!nodes.has(edge.child)) nodes.set(edge.child, { id: edge.child } as Node<P>);

    edges.set(edge.id, edge);
    addToIndex(forward, edge.parent, edge.id);
    addToIndex(inverse, edge.child, edge.id);
  }

  if (violations.length) return { ok: false, violations };

  return {
    ok: true,
    value: { ...space, revision: space.revision + 1, nodes, edges, forward, inverse },
  };
}

/**
 * Check one edge against the profile and the acyclicity invariant, in the context of a space that
 * already has the delta's removals applied.
 */
export function validateEdge<P>(space: GroupSpace<P>, edge: Edge): Violation[] {
  const p = space.profile;
  const out: Violation[] = [];

  if (edge.parent === edge.child) {
    out.push({ code: 'selfEdge', message: `A node cannot contain itself: ${edge.child}.`, edge });
    return out;
  }

  const kindDef = p.edgeKinds[edge.kind];
  if (!kindDef) {
    out.push({
      code: 'unknownEdgeKind',
      message: `Edge kind '${edge.kind}' is not declared in profile '${p.name}'. Declared kinds: ${Object.keys(p.edgeKinds).join(', ')}.`,
      edge,
    });
    return out;
  }

  // Duplicate (same parent, child, kind).
  const duplicate = edgesOf(space, edge.parent).some(
    (e) => e.child === edge.child && e.kind === edge.kind && e.id !== edge.id,
  );
  if (duplicate) {
    out.push({
      code: 'duplicateEdge',
      message: `${edge.child} is already in ${edge.parent} via '${edge.kind}'.`,
      edge,
    });
  }

  // Disjoint kinds: SKOS S27 — `related` may not co-exist with a hierarchical edge.
  if (kindDef.disjointWith?.length) {
    const conflicting = edgesOf(space, edge.parent).find(
      (e) => e.child === edge.child && kindDef.disjointWith!.includes(e.kind),
    );
    if (conflicting) {
      out.push({
        code: 'disjointEdgeKind',
        message: `Edge kind '${edge.kind}' is disjoint from '${conflicting.kind}', which already links ${edge.parent} → ${edge.child}.`,
        edge,
      });
    }
  }

  // Acyclicity. Enforced for any kind that participates in closure.
  if (kindDef.transitive || kindDef.acyclic) {
    const cycle = findCycle(space, edge.parent, edge.child);
    if (cycle) {
      out.push({
        code: 'cycle',
        message: `Adding ${edge.child} to ${edge.parent} would create a cycle: ${cycle.join(' → ')}.`,
        edge,
        path: cycle,
      });
    }
  }

  const childIsGroup = isGroup(space, edge.child);

  if (childIsGroup && !p.groupsMayContainGroups) {
    out.push({
      code: 'groupsMayContainGroups',
      message: `Profile '${p.name}' forbids groups inside groups (${edge.child} is a group).`,
      edge,
    });
  }
  if (!childIsGroup && !p.groupsMayContainItems) {
    out.push({
      code: 'groupsMayContainItems',
      message: `Profile '${p.name}' forbids items inside groups; ${edge.child} is not a group.`,
      edge,
    });
  }

  // Parent-count caps. A node's cap depends on whether it is itself a group.
  const currentParents = space.inverse.get(edge.child)?.size ?? 0;
  const cap = childIsGroup ? p.maxParentsPerGroup : p.maxParentsPerItem;
  if (cap !== null && currentParents + 1 > cap) {
    out.push({
      code: childIsGroup ? 'maxParentsPerGroup' : 'maxParentsPerItem',
      message: `${edge.child} would have ${currentParents + 1} parents; profile '${p.name}' allows ${cap}.`,
      edge,
    });
  }

  if (!childIsGroup && p.maxGroupsPerItem !== null && currentParents + 1 > p.maxGroupsPerItem) {
    out.push({
      code: 'maxGroupsPerItem',
      message: `${edge.child} would be in ${currentParents + 1} groups; profile '${p.name}' allows ${p.maxGroupsPerItem}.`,
      edge,
    });
  }

  // Depth of the GROUP hierarchy. `maxDepth: 0` means flat — no group may sit inside another —
  // while still permitting an item to be tagged, which is exactly the flat-tagging case.
  // Putting a plain item into a group adds no nesting, so it is never capped by `maxDepth`.
  if (p.maxDepth !== null && kindDef.transitive && childIsGroup) {
    const resulting = depthAbove(space, edge.parent) + 1 + groupDepthBelow(space, edge.child);
    if (resulting > p.maxDepth) {
      out.push({
        code: 'maxDepth',
        message: `Nesting ${edge.child} inside ${edge.parent} would make the group hierarchy ${resulting} deep; profile '${p.name}' allows ${p.maxDepth}.`,
        edge,
      });
    }
  }

  return out;
}

// ── undo, for free ──────────────────────────────────────────────────────────

/**
 * The inverse of a delta, computed against the space it was applied to.
 *
 * Undo is Command, not Memento: we never snapshot the space, we just swap `added` and `removed`.
 */
export function invert<P>(space: GroupSpace<P>, delta: EdgeDelta): EdgeDelta {
  const removedEdges = (delta.removed ?? [])
    .map((id) => space.edges.get(id))
    .filter((e): e is Edge => Boolean(e));
  return {
    added: removedEdges,
    removed: (delta.added ?? []).map((e) => e.id),
  };
}

// ── ergonomic wrappers (all of them are just deltas) ────────────────────────

/** Put a node in a group. Under `filesystem` this fails if it already has a parent — by design. */
export function addTo<P>(
  space: GroupSpace<P>,
  child: NodeId,
  parent: NodeId,
  init: Partial<Omit<Edge, 'parent' | 'child'>> = {},
): Result<GroupSpace<P>> {
  return applyDelta(space, { added: [makeEdge(parent, child, init)] });
}

/** Take a node out of one group. Not a delete — the node and its other memberships survive. */
export function removeFrom<P>(space: GroupSpace<P>, child: NodeId, parent: NodeId): Result<GroupSpace<P>> {
  const ids = edgesInto(space, child)
    .filter((e) => e.parent === parent)
    .map((e) => e.id);
  return applyDelta(space, { removed: ids });
}

/**
 * Move a node from one group to another — remove + add, atomically.
 *
 * Distinct from `addTo`, and the distinction is the single most dangerous one in the UI: a *move*
 * destroys an edge the user often cannot see. Renderers should default to `addTo` and require a
 * modifier for `moveTo` (Gmail's `Label` vs `Move to`).
 */
export function moveTo<P>(
  space: GroupSpace<P>,
  child: NodeId,
  from: NodeId,
  to: NodeId,
  init: Partial<Omit<Edge, 'parent' | 'child'>> = {},
): Result<GroupSpace<P>> {
  const removed = edgesInto(space, child)
    .filter((e) => e.parent === from)
    .map((e) => e.id);
  return applyDelta(space, { removed, added: [makeEdge(to, child, init)] });
}

/** Delete a node entirely, and every edge touching it. This *is* destructive. */
export function deleteNode<P>(space: GroupSpace<P>, id: NodeId): Result<GroupSpace<P>> {
  const touching = [...edgesInto(space, id), ...edgesOf(space, id)].map((e) => e.id);
  const result = applyDelta(space, { removed: touching });
  if (!result.ok) return result;
  const nodes = new Map(result.value.nodes);
  nodes.delete(id);
  return { ok: true, value: { ...result.value, nodes } };
}

/**
 * Can this node be added to this group? Returns the violations, so the UI can explain *why not*.
 *
 * This is what a drag-and-drop target calls on hover.
 */
export function canAddTo<P>(space: GroupSpace<P>, child: NodeId, parent: NodeId, kind = CONTAINS): Violation[] {
  return validateEdge(space, makeEdge(parent, child, { kind }));
}
