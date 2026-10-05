/**
 * `@zodal/groups-core` — hierarchical grouping of items, without "only in one place".
 *
 * Membership is the canonical data: a flat set of reified edges. Every folder tree, tag cloud, facet
 * browser and breadcrumb is a pure **projection** over that edge set. A filesystem and a tag cloud
 * are the same object with different constraints — which is why one library covers pure hierarchies,
 * flat tagging, nested groups, Gmail-style labels, taxonomies, and the general polyhierarchical case.
 *
 * ```ts
 * import { defineGroups } from '@zodal/groups-core';
 *
 * const g = defineGroups({ profile: 'labels' });   // items multi-parent; label tree is a tree
 * g.add('msg-1', 'work');
 * g.add('msg-1', 'urgent');
 * g.otherLocations('msg-1');                       // → also in 'work' and 'urgent'
 * g.tree();                                        // → PathNode[] — feed any renderer
 * ```
 *
 * Start with `defineGroups`. Everything else here is for building on top.
 *
 * @see `docs/zodal-groups-concept.md` for the thesis, `docs/research/_reconciliation.md` for the
 *   decisions and the evidence behind them.
 */

// ── the entry point ─────────────────────────────────────────────────────────
export { defineGroups, type DefineGroupsOptions, type Groups, type GroupsChange } from './define.js';

// ── the model ───────────────────────────────────────────────────────────────
export {
  nodeId,
  edgeId,
  memberId,
  defaultIdentity,
  CONTAINS,
  DEFAULT_EDGE_KINDS,
  EXCLUSIVE,
  type FamilyRule,
  type NodeId,
  type EdgeId,
  type Edge,
  type EdgeKind,
  type EdgeKindDef,
  type EdgeDelta,
  type GroupSpace,
  type IdentityStrategy,
  type Member,
  type Node,
  type Result,
  type Violation,
} from './model.js';

// ── profiles ────────────────────────────────────────────────────────────────
export {
  PROFILES,
  resolveProfile,
  isFlat,
  isGroupTree,
  isSingleHomed,
  type GroupProfile,
  type ProfileName,
} from './profile.js';

// ── the space: pure, immutable, framework-free ──────────────────────────────
export {
  createGroupSpace,
  applyDelta,
  invert,
  makeEdge,
  validateEdge,
  validateProfile,
  addTo,
  removeFrom,
  moveTo,
  deleteNode,
  deleteNodeDelta,
  canAddTo,
  findCycle,
  childrenOf,
  parentsOf,
  edgesOf,
  edgesInto,
  isGroup,
  rootsOf,
  orphansOf,
  type CreateSpaceOptions,
} from './space.js';

// ── structure: the one node/edge validator for write and read ──────────────
export { isFamilyRule, nodeProblem, edgeProblem } from './structure.js';

// ── families: per-family cardinality ────────────────────────────────────────
export { familyValuesOf, familyViolations, hasFamilyAtOrAbove } from './family.js';

// ── profile inference ───────────────────────────────────────────────────────
export {
  inferProfile,
  observeDials,
  type InferProfileOptions,
  type InferredProfile,
  type ObservedDials,
  type ProfileEvidence,
} from './infer.js';

// ── persistence: snapshots and the GroupStore contract ──────────────────────
export {
  toSnapshot,
  fromSnapshot,
  parseSnapshot,
  type FromSnapshotOptions,
  type GroupSnapshot,
} from './snapshot.js';
export {
  createMemoryGroupStore,
  createListenerSet,
  CLIENT_SIDE_CAPABILITIES,
  type GroupStore,
  type GroupStoreCapabilities,
  type GroupStoreChange,
  type MemoryGroupStoreOptions,
} from './store.js';

// ── closure ─────────────────────────────────────────────────────────────────
export {
  ancestors,
  descendants,
  closureIds,
  membersOf,
  countIn,
  isWithin,
  detectCycles,
  type WalkOptions,
} from './closure.js';

// ── projections ─────────────────────────────────────────────────────────────
export {
  projectTree,
  toggleExpanded,
  expandedForPath,
  twinsOf,
  pathKeyOf,
  pathFromKey,
  type PathNode,
  type TreeOptions,
} from './projections/tree.js';

export { projectColumns, type Column, type ColumnsOptions } from './projections/columns.js';

export {
  allPaths,
  primaryPath,
  breadcrumbs,
  otherLocations,
  type NodePath,
  type OtherLocation,
  type PathOptions,
} from './projections/paths.js';

export {
  facetPanel,
  matchingItems,
  groupsOfItem,
  allItems,
  scopeFilter,
  type FacetOptions,
  type FacetValue,
} from './projections/facets.js';

// ── intensional ("smart") groups ────────────────────────────────────────────
export {
  extentOf,
  unfiled,
  multiHomed,
  smartGroup,
  type GroupRule,
  type IntensionalGroup,
} from './intensional.js';

// ── ordering ────────────────────────────────────────────────────────────────
export { orderBetween, initialOrders, compareOrder } from './order.js';

// ── health ──────────────────────────────────────────────────────────────────
export { lint, type Lint } from './lint.js';
