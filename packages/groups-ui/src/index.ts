/**
 * `@zodal/groups-ui` — the headless UI layer for zodal-groups.
 *
 * Produces configuration objects, never DOM. Concrete renderers (`@zodal/groups-ui-vanilla`,
 * `-shadcn`, `-ark`) consume these descriptors; so can yours.
 *
 * Three things live here, and each is a place where getting it wrong ships a bug that survives code
 * review:
 *
 * - **`views`** — `toTreeRows` and friends. Rows are keyed by `pathKey` for the DOM and by `nodeId`
 *   for selection, and they carry the ARIA that multi-parenthood requires.
 * - **`drag`** — the add-vs-move intent model. ADD is the default; MOVE needs a modifier, because
 *   MOVE destroys an edge the user often cannot see.
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
  resolveDrop,
  applyDrop,
  MEMBERSHIP_ACTIONS,
  type DragGesture,
  type DropOperation,
  type DropTarget,
  type MembershipAction,
} from './drag.js';

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
