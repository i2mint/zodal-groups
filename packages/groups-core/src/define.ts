/**
 * `defineGroups` — the facade, and the only thing most users ever touch.
 *
 * Progressive disclosure is the whole design of this module: `defineGroups({ profile: 'filesystem' })`
 * gets you folders, and you never learn the word "polyhierarchy". The full edge model, the closure
 * engine, and the projection layer are all still there, one property away, when you need them.
 *
 * The facade is a **stateful convenience wrapper** over the pure functional core. Everything it does
 * is `applyDelta(space, …)` and a projection call; if you would rather thread an immutable
 * `GroupSpace` through your own state manager (Zustand, Redux, signals), import from `./space` and
 * `./projections` directly and ignore this file. That is a supported path, not a fallback — the core
 * has no reactivity and no opinion about who owns the state.
 */

import {
  nodeId,
  type Edge,
  type EdgeDelta,
  type EdgeKind,
  type GroupSpace,
  type Node,
  type NodeId,
  type Result,
  type Violation,
} from './model.js';
import { resolveProfile, type GroupProfile, type ProfileName } from './profile.js';
import {
  addTo,
  applyDelta,
  canAddTo,
  childrenOf,
  createGroupSpace,
  deleteNode,
  invert,
  moveTo,
  orphansOf,
  parentsOf,
  removeFrom,
  rootsOf,
} from './space.js';
import { ancestors, closureIds, countIn, descendants, detectCycles, membersOf } from './closure.js';
import { projectTree, type PathNode, type TreeOptions } from './projections/tree.js';
import { projectColumns, type Column, type ColumnsOptions } from './projections/columns.js';
import {
  allPaths,
  breadcrumbs,
  otherLocations,
  primaryPath,
  type NodePath,
  type OtherLocation,
} from './projections/paths.js';
import { facetPanel, scopeFilter, type FacetOptions, type FacetValue } from './projections/facets.js';
import { lint, type Lint } from './lint.js';

export interface DefineGroupsOptions<P> {
  readonly profile?: ProfileName | GroupProfile;
  /** Per-field overrides on top of the named profile — the "hybrid" case. */
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  readonly nodes?: readonly Node<P>[];
  readonly edges?: readonly Edge[];
}

/** A change notification. `revision` is a valid memoization key for any host framework. */
export interface GroupsChange {
  readonly delta: EdgeDelta;
  readonly revision: number;
}

/**
 * A live handle on a group space.
 *
 * Mutations return a `Result` rather than throwing: a rejected re-parent is an ordinary, expected
 * outcome (the user dragged a folder into its own descendant), and the violations carry the *path*
 * that explains why — which is what a drop-target tooltip needs in order to say something better
 * than "no".
 */
export interface Groups<P = unknown> {
  readonly profile: GroupProfile;
  /** The current immutable state. */
  readonly space: GroupSpace<P>;
  readonly revision: number;

  // ── writes (all of them are deltas underneath) ────────────────────────────
  add(child: NodeId | string, parent: NodeId | string, init?: Partial<Omit<Edge, 'parent' | 'child'>>): Result<GroupSpace<P>>;
  remove(child: NodeId | string, parent: NodeId | string): Result<GroupSpace<P>>;
  move(child: NodeId | string, from: NodeId | string, to: NodeId | string): Result<GroupSpace<P>>;
  destroy(node: NodeId | string): Result<GroupSpace<P>>;
  apply(delta: EdgeDelta): Result<GroupSpace<P>>;
  /** Undo the last applied delta. Returns `false` when there is nothing to undo. */
  undo(): boolean;

  // ── guards ────────────────────────────────────────────────────────────────
  /** Why can't this be dropped here? Empty array means it can. */
  canAdd(child: NodeId | string, parent: NodeId | string, kind?: EdgeKind): Violation[];

  // ── reads ─────────────────────────────────────────────────────────────────
  children(group: NodeId | string): NodeId[];
  /** The groups a node is directly in. The "tags" view — always live, never converted. */
  parents(child: NodeId | string): NodeId[];
  ancestors(node: NodeId | string): NodeId[];
  descendants(group: NodeId | string): NodeId[];
  members(group: NodeId | string, options?: { expand?: 'direct' | 'closure'; itemsOnly?: boolean }): NodeId[];
  count(group: NodeId | string, options?: { expand?: 'direct' | 'closure' }): number;
  roots(): NodeId[];
  /** Nodes in no group at all — Zotero's "Unfiled Items". */
  orphans(): NodeId[];

  // ── projections ───────────────────────────────────────────────────────────
  tree(options?: TreeOptions): PathNode[];
  columns(options?: ColumnsOptions): Column[];
  facets(options?: FacetOptions): FacetValue[];
  paths(node: NodeId | string): NodePath[];
  path(node: NodeId | string): NodePath | undefined;
  breadcrumbs(node: NodeId | string, options?: { arrivedVia?: readonly NodeId[] }): NodePath | undefined;
  /** "What other groups is this in?" — meaningless in a tree, essential here. */
  otherLocations(node: NodeId | string, excluding?: NodeId | string): OtherLocation[];
  /** A `FilterExpression` scoping a `@zodal/store` query to this group and its subgroups. */
  scope(group: NodeId | string, options?: { field?: string; expand?: 'direct' | 'closure' }): ReturnType<typeof scopeFilter>;

  // ── health ────────────────────────────────────────────────────────────────
  lint(): Lint[];
  cycles(): NodeId[][];

  // ── change stream ─────────────────────────────────────────────────────────
  subscribe(listener: (change: GroupsChange) => void): () => void;
}

const id = (v: NodeId | string): NodeId => (typeof v === 'string' ? nodeId(v) : v);

/**
 * Create a group space.
 *
 * @example Folders — an item lives in exactly one place.
 * const g = defineGroups({ profile: 'filesystem' });
 * g.add('report.pdf', 'documents');
 * g.add('report.pdf', 'archive');   // → { ok: false, violations: [maxParentsPerItem] }
 *
 * @example Gmail labels — many groups per item, but the label tree is a tree.
 * const g = defineGroups({ profile: 'labels' });
 * g.add('msg-1', 'work');
 * g.add('msg-1', 'urgent');         // → ok. Same message, two labels.
 * g.otherLocations('msg-1');        // → [{ group: 'work' }, { group: 'urgent' }]
 *
 * @example Hybrid — the user's "max 3 levels, max 5 groups per item" case.
 * defineGroups({ profile: 'polyhierarchy', overrides: { maxDepth: 3, maxGroupsPerItem: 5 } });
 */
export function defineGroups<P = unknown>(options: DefineGroupsOptions<P> = {}): Groups<P> {
  const profile = resolveProfile(options.profile, options.overrides);
  let space = createGroupSpace<P>({
    profile,
    ...(options.nodes ? { nodes: options.nodes } : {}),
    ...(options.edges ? { edges: options.edges } : {}),
  });

  const history: EdgeDelta[] = [];
  const listeners = new Set<(change: GroupsChange) => void>();

  /** Commit a result, record it for undo, and notify. */
  const commit = (result: Result<GroupSpace<P>>, delta: EdgeDelta): Result<GroupSpace<P>> => {
    if (!result.ok) return result;
    const inverse = invert(space, delta);
    space = result.value;
    history.push(inverse);
    for (const listener of listeners) listener({ delta, revision: space.revision });
    return result;
  };

  return {
    get profile() {
      return profile;
    },
    get space() {
      return space;
    },
    get revision() {
      return space.revision;
    },

    add(child, parent, init = {}) {
      const delta: EdgeDelta = { added: [] };
      const result = addTo(space, id(child), id(parent), init);
      // Recover the edge that `addTo` minted, so undo can remove exactly it.
      if (result.ok) {
        const added = [...result.value.edges.values()].filter((e) => !space.edges.has(e.id));
        return commit(result, { ...delta, added });
      }
      return result;
    },

    remove(child, parent) {
      const removed = [...space.edges.values()]
        .filter((e) => e.child === id(child) && e.parent === id(parent))
        .map((e) => e.id);
      return commit(removeFrom(space, id(child), id(parent)), { removed });
    },

    move(child, from, to) {
      const before = space;
      const result = moveTo(space, id(child), id(from), id(to));
      if (!result.ok) return result;
      const removed = [...before.edges.values()]
        .filter((e) => e.child === id(child) && e.parent === id(from))
        .map((e) => e.id);
      const added = [...result.value.edges.values()].filter((e) => !before.edges.has(e.id));
      return commit(result, { added, removed });
    },

    destroy(node) {
      const before = space;
      const result = deleteNode(space, id(node));
      if (!result.ok) return result;
      const removed = [...before.edges.values()]
        .filter((e) => !result.value.edges.has(e.id))
        .map((e) => e.id);
      return commit(result, { removed });
    },

    apply(delta) {
      return commit(applyDelta(space, delta), delta);
    },

    undo() {
      const delta = history.pop();
      if (!delta) return false;
      const result = applyDelta(space, delta);
      if (!result.ok) return false;
      space = result.value;
      for (const listener of listeners) listener({ delta, revision: space.revision });
      return true;
    },

    canAdd(child, parent, kind) {
      return canAddTo(space, id(child), id(parent), kind);
    },

    children: (group) => childrenOf(space, id(group)),
    parents: (child) => parentsOf(space, id(child)),
    ancestors: (node) => [...ancestors(space, id(node))],
    descendants: (group) => [...descendants(space, id(group))],
    members: (group, opts) => membersOf(space, id(group), opts),
    count: (group, opts) => countIn(space, id(group), opts),
    roots: () => rootsOf(space),
    orphans: () => orphansOf(space),

    tree: (opts) => projectTree(space, opts),
    columns: (opts) => projectColumns(space, opts),
    facets: (opts) => facetPanel(space, opts),
    paths: (node) => allPaths(space, id(node)),
    path: (node) => primaryPath(space, id(node)),
    breadcrumbs: (node, opts) => breadcrumbs(space, id(node), opts),
    otherLocations: (node, excluding) =>
      otherLocations(space, id(node), excluding ? id(excluding) : undefined),
    scope: (group, opts) => scopeFilter(space, id(group), opts),

    lint: () => lint(space),
    cycles: () => detectCycles(space),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Re-export for callers who want the closure ids without a `Groups` handle. */
export { closureIds };
