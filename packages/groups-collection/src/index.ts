/**
 * `@zodal/groups-collection` — one CRUD object over a zodal item collection and its zodal-groups
 * memberships, kept consistent.
 *
 * ```ts
 * import { defineTaggedCollection } from '@zodal/groups-collection';
 * import { createInMemoryProvider } from '@zodal/store';
 *
 * const tc = defineTaggedCollection({
 *   provider: createInMemoryProvider([{ id: 'a', title: 'Alpha', tags: [] }]),
 *   spaces: { tags: { profile: 'flatTags', edges: { embedded: 'tags' } } },
 * });
 * const r = await tc.tag(['a'], 'urgent');   // → { ok, succeeded, failed, inverse }
 * await tc.revert(r.inverse);                 // undo lives in the app's history, not here
 * ```
 *
 * - **Several named spaces** over one item universe: each keeps its edges on the records
 *   (`{ embedded: '<field>' }`, works over any `DataProvider`) or in a `GroupStore`.
 * - **Per-item failure semantics**: a record and its edges succeed together or are compensated; a
 *   bulk operation keeps what succeeded and reports the rest (`{ succeeded, failed }`). Profile,
 *   family and cycle rules are checked before any record is written.
 * - **Every operation returns its inverse** (plain data); `revert` applies it. No history here.
 * - **`operations` and `commands`** (acture's `CommandRecord` shape) with shared ids.
 *
 * @see `docs/research/_reconciliation.md` (D7, D10, D25, D26, D28) and the
 *   `zodal-groups-dev-collection` skill.
 */

export { defineTaggedCollection } from './define.js';
export {
  operations,
  createCommands,
  commandId,
  commandParams,
  toCommandResult,
  INVERSE_EFFECT,
  type CommandEffect,
  type CommandPatch,
  type CommandResult,
  type CreateCommandsOptions,
  type GroupsCommand,
} from './commands.js';
export { isEmptyInverse } from './engine.js';
export { recordEdgeId, isRecordEdge, fieldGroups, RECORD_EDGE_PREFIX } from './spaces.js';
export type {
  BulkTagChange,
  CollectionChange,
  CollectionInverse,
  CollectionLike,
  CreateOptions,
  DefineTaggedCollectionOptions,
  EmbeddedEdges,
  Failure,
  FailureCode,
  ItemInverse,
  OperationResult,
  RecordOp,
  RenameOptions,
  SpaceConfig,
  SpaceEdges,
  SpaceOption,
  TagOptions,
  TaggedCollection,
  Vocabulary,
} from './types.js';
