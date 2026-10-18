/**
 * `@zodal/groups-ui` — the headless UI layer for zodal-groups.
 *
 * Produces configuration objects, never DOM, and never writes to a store. Concrete renderers
 * (`@zodal/groups-ui-vanilla`, `-shadcn`, `-ark`) consume these descriptors; so can yours.
 *
 * Six things live here, and each is a place where getting it wrong ships a bug that survives code
 * review:
 *
 * - **`views`** — `toTreeRows` and friends. Rows are keyed by `pathKey` for the DOM and by `nodeId`
 *   for selection, and they carry the ARIA that multi-parenthood requires.
 * - **`drag`** — the add-vs-move intent model. ADD is the default; MOVE needs a modifier, because
 *   MOVE destroys an edge the user often cannot see.
 * - **`chips`** — `toGroupChips`, the drill-down chip rows (All · groups with counts · Ungrouped)
 *   for browsing nested groups on a phone. The whole view state is one path, like Miller columns.
 *   `allChipItems` lets the All chip stand for another set (a "recently viewed" home).
 * - **`tagging`** — the selection-level tagging menu (Gmail's label menu): a none/some/all state per
 *   group, staged changes, refusals explained before the click, and a plan the caller writes.
 * - **`messages`** — every `Violation` as a sentence plus a suggested fix, and the menu's copy; one
 *   overridable table, so a host can reword or translate it.
 * - **`registry`** — the capability-ranked renderer registry, the same open-closed pattern as
 *   `@zodal/ui`.
 */

export {
  toTreeRows,
  toBreadcrumbs,
  toFacetRows,
  toTagTokens,
  toOtherLocations,
  type TreeRow,
  type TreeViewOptions,
  type BreadcrumbView,
  type Crumb,
  type FacetRow,
  type TagToken,
  type OtherLocationRow,
} from './views.js';

export {
  toGroupChips,
  groupChipItems,
  normalizeChipSelection,
  sameChipSelection,
  ALL_GROUPS,
  GROUP_CHIPS_LABELS,
  type GroupChip,
  type GroupChipKind,
  type GroupChipRow,
  type GroupChipsLabels,
  type GroupChipsOptions,
  type GroupChipsSelection,
  type GroupChipsView,
} from './chips.js';

export {
  resolveDrop,
  applyDrop,
  MEMBERSHIP_ACTIONS,
  type DragGesture,
  type DropOperation,
  type DropTarget,
  type MembershipAction,
  type ResolveDropOptions,
} from './drag.js';

export {
  toTaggingView,
  toggleTag,
  createTag,
  setTagQuery,
  resetTag,
  createTaggingSession,
  planToDelta,
  applyTagging,
  describeOutcome,
  mergeOutcomes,
  resolveSpace,
  EMPTY_TAGGING_STATE,
  type TagState,
  type TagRow,
  type CreateOption,
  type GroupChange,
  type TaggingBatch,
  type TaggingPlan,
  type TaggingState,
  type TaggingOptions,
  type TaggingView,
  type TaggingSession,
  type Refusal,
  type SpaceSource,
  type ApplyOutcome,
  type ApplyFailure,
  type DescribeOptions,
} from './tagging.js';

export {
  explainViolation,
  explainViolations,
  labelFor,
  resolveMessages,
  sentence,
  VIOLATION_MESSAGES,
  VIOLATION_CODES,
  TAGGING_MESSAGES,
  DEFAULT_MESSAGES,
  type ExplainedViolation,
  type ExplainOptions,
  type GroupsUiMessages,
  type LabelOf,
  type MessagesOverride,
  type TaggingMessages,
  type ViolationCode,
  type ViolationContext,
  type ViolationMessages,
  type ViolationTemplate,
  type ViolationText,
} from './messages.js';

export {
  createRendererRegistry,
  PRIORITY,
  profileIs,
  surfaceIs,
  isPolyhierarchical,
  and,
  or,
  type RendererEntry,
  type RendererRegistry,
  type RendererTester,
  type RendererContext,
  type Surface,
} from './registry.js';
