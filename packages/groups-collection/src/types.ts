/**
 * Public types of `@zodal/groups-collection`: the options of `defineTaggedCollection`, what every
 * operation returns, and the inverse that undoes it.
 *
 * Two shapes carry the design:
 *
 * - **`OperationResult`** — `{ ok, succeeded, failed, inverse }`. A bulk operation keeps what
 *   succeeded and reports what failed, item by item (acture's "partial stays applied"; Dexie's
 *   `BulkError`), and `inverse` undoes exactly the applied part.
 * - **`CollectionInverse`** — plain data (JSON-serializable), split per item so that undoing it has
 *   the same per-item semantics as doing it. There is no history in this package: the app's history
 *   (acture-undo, or its hand-written equivalent) stores inverses and hands them back to
 *   `revert` (zgroups_05 §1.8: "do not build a separate undo subsystem").
 */

import type { Edge, EdgeDelta, EdgeKind, GroupProfile, GroupSpace, GroupStore, Node, ProfileName, Violation } from '@zodal/groups-core';
import type { FilterCondition, OperationDefinition } from '@zodal/core';
import type { DataProvider } from '@zodal/store';
import type { GroupsCommand } from './commands.js';

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Embedded edges: the space's memberships live on the item records, as a `string[]` field of group
 * ids (`{ embedded: 'tags' }`). Works over every `DataProvider`, and is what `scopeFilter` (and so
 * `arrayContainsAny`) already assumes. The space is derived from the records on load.
 */
export interface EmbeddedEdges {
  readonly embedded: string;
  /**
   * How the field orders its group ids: `'insertion'` (default — new groups are appended, a
   * renamed or merged group keeps its place) or `'sorted'` (binary order, kept on every write).
   */
  readonly order?: 'insertion' | 'sorted';
}

/** Where a space's edges live: on the records (`{ embedded: field }`) or in a `GroupStore`. */
export type SpaceEdges = EmbeddedEdges | GroupStore;

/**
 * Group-level structure for an embedded space, declared in code: group nodes (labels, `family`
 * rules) and group-to-group edges. An item record can only carry its own memberships, so this is
 * held in memory and never persisted; changes an operation makes to it (deleting or merging a
 * declared group) last for the instance's lifetime. Use a `GroupStore` space when the group
 * structure must be edited and persisted.
 */
export interface Vocabulary {
  readonly nodes?: readonly Node[];
  readonly edges?: readonly Edge[];
}

/** One named group space over the collection's items. */
export interface SpaceConfig {
  /**
   * The profile writes are validated against. Embedded spaces default to `'polyhierarchy'` (the
   * general acyclic case). A store space validates with its store's profile; if given here it must
   * name the same profile.
   */
  readonly profile?: ProfileName | GroupProfile;
  /** Per-field overrides on top of `profile` (embedded spaces only; a store has its own). */
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  readonly edges: SpaceEdges;
  /** Embedded spaces only: group nodes and group-to-group edges declared in code (see {@link Vocabulary}). */
  readonly vocabulary?: Vocabulary;
}

/** Anything with an `idField` (a `CollectionDefinition` from `@zodal/core` fits). */
export interface CollectionLike {
  readonly idField?: string;
  readonly schema?: unknown;
}

export interface DefineTaggedCollectionOptions<T extends Record<string, unknown>> {
  /** The zodal collection the items belong to. Gives the `idField` and lets embedded fields be checked against its schema. */
  readonly collection?: CollectionLike;
  /** Where the item records live. */
  readonly provider: DataProvider<T>;
  /**
   * The named group spaces over the items (the Zotero acid test, zgroups_05 §8.3: collections and
   * tags over one item universe). Default: `{ groups: { edges: { embedded: 'groups' } } }`.
   */
  readonly spaces?: Readonly<Record<string, SpaceConfig>>;
  /** The space an operation uses when it names none. Default: the first space declared. */
  readonly defaultSpace?: string;
  /** The record field holding the item id. Default: `collection.idField`, else `'id'`. */
  readonly idField?: string;
  /** How many times a `GroupStore` write is retried after a `conflict` (another writer got there first). Default 3. */
  readonly maxRetries?: number;
  /** Base delay before such a retry, in ms; it grows exponentially, with jitter, up to 40×. Default 5. */
  readonly retryDelayMs?: number;
  /** Page size used to read every record when deriving embedded spaces. Default 1000. */
  readonly loadPageSize?: number;
  /** Where a throwing `subscribe` listener's error goes. Default `console.error`. */
  readonly onListenerError?: (error: unknown) => void;
  /**
   * Namespace of the command ids (`<namespace>.tag`, …), also put on each undo effect as
   * `collection`. Default `'groups'`; give each collection its own when an app has several.
   */
  readonly commandNamespace?: string;
}

// ── results ─────────────────────────────────────────────────────────────────

/** Why one item (or, for a group-level operation, the group) was not changed. */
export type FailureCode =
  /** No record with this id (or no such group in the space). */
  | 'notFound'
  /** The change breaks the space's profile, a family rule, or acyclicity — refused before any write. */
  | 'violation'
  /** `create`: a record with this id already exists. */
  | 'exists'
  /** The record write failed (the provider rejected). Nothing of this item stayed applied. */
  | 'recordWrite'
  /** The `GroupStore` write failed with an I/O error. */
  | 'storeWrite'
  /** Another writer kept winning: still conflicting after `maxRetries` retries. */
  | 'conflict'
  /** The operation does not apply here (e.g. deleting, as a group, a node that is a record of an embedded space). */
  | 'unsupported'
  /** A group of that id already exists (a rename by id would merge; use `mergeGroups`). */
  | 'groupExists';

export interface Failure {
  /** The item id; for a group-level operation, the group id. */
  readonly id: string;
  readonly code: FailureCode;
  /** A sentence a person can act on. */
  readonly reason: string;
  readonly violations?: readonly Violation[];
  /**
   * The item's record and its edges could not be brought back into agreement: a write succeeded,
   * a later one failed, and the compensation failed too. Rare (two failures in a row); the reason
   * says which half is left over.
   */
  readonly inconsistent?: true;
}

/** A record-level change to undo: delete a record an operation created, or create again one it deleted. */
export type RecordOp<T> = { readonly op: 'delete' } | { readonly op: 'create'; readonly data: T };

/** The part of an inverse that belongs to one item. */
export interface ItemInverse<T> {
  readonly id: string;
  /** Present when the operation created or deleted the record. Field changes are not here: they follow from `edges`. */
  readonly record?: RecordOp<T>;
  /** Per space, the edge changes that undo this item's part. */
  readonly edges: Readonly<Record<string, EdgeDelta>>;
  /**
   * The embedded fields as they were before (`{}` for a field that was absent). The field a revert
   * writes is computed from `edges`; when it holds the same groups as this, this is written instead,
   * so the item's order survives an undo — and a field someone changed since is never overwritten.
   */
  readonly fields?: Readonly<Record<string, { readonly value?: unknown }>>;
  /**
   * The embedded fields as the operation left them. A revert refuses (`conflict`) an item whose
   * field has changed since for a group the revert touches: undoing would overwrite that change.
   */
  readonly fieldsAfter?: Readonly<Record<string, { readonly value?: unknown }>>;
}

/**
 * Undoes one operation: pass it to `revert`. Plain data — store it in any history.
 *
 * Split per item so that reverting has the same per-item semantics as the operation itself (one
 * item's undo can fail while the others apply).
 */
export interface CollectionInverse<T> {
  readonly items: readonly ItemInverse<T>[];
  /** Per space, group-level changes (group nodes, group-to-group edges). Applied with the items. */
  readonly shared: Readonly<Record<string, EdgeDelta>>;
  /**
   * Per space, the nodes as this operation left them. `revert` refuses to restore a node that
   * changed since (a rename undone after someone else renamed it again would overwrite their
   * rename).
   */
  readonly expect: Readonly<Record<string, readonly Node[]>>;
  /**
   * Per space, the edges the operation replaced under their own ids (a move's new rank), as it left
   * them. `revert` refuses (`conflict`) to restore one that was removed or changed since.
   */
  readonly expectEdges?: Readonly<Record<string, readonly Edge[]>>;
}

export interface OperationResult<T> {
  /** `true` iff nothing failed. */
  readonly ok: boolean;
  /**
   * The items changed (or already in the requested state). A group operation (delete, merge,
   * rename) also lists the group once its group-level change applied — in embedded spaces after
   * the members it rewrote.
   */
  readonly succeeded: readonly string[];
  readonly failed: readonly Failure[];
  /** Undoes exactly what was applied. Empty when nothing was. */
  readonly inverse: CollectionInverse<T>;
  /** `create` only: the record as the provider stored it. */
  readonly record?: T;
}

/** What `subscribe` listeners receive, once per operation that changed something. */
export interface CollectionChange<T> {
  readonly operation: string;
  readonly result: OperationResult<T>;
}

// ── operation options ───────────────────────────────────────────────────────

export interface SpaceOption {
  /** Which space. Default: `defaultSpace`. */
  readonly space?: string;
}

/** Where a member goes in an ordered group: just before or just after another member (exactly one). */
export type Position = { readonly before: string; readonly after?: undefined } | { readonly after: string; readonly before?: undefined };

export interface TagOptions extends SpaceOption {
  /** Edge kind (store spaces; an embedded field can only say `contains`). Default `contains`. */
  readonly kind?: EdgeKind;
  /**
   * Ordered spaces only (a store whose profile is `ordered`): place the new members, in the given
   * order, just before or after this member. Without it they go at the end. Ranks are fractional
   * indexes (`orderBetween`), so nobody else's rank changes.
   */
  readonly position?: Position;
}

export type MoveOptions = SpaceOption & Position;

export interface BulkTagChange extends TagOptions {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
  /**
   * Labels for groups in `add` that this change CREATES (a group that exists keeps its label: use
   * `renameGroup` for that). Store spaces only: an embedded field stores ids, so a label other than
   * the id is refused there. The tagging menu's `plan.batches` fill it for groups created in the menu.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface RenameOptions extends SpaceOption {
  /**
   * `'label'`: set the group node's label; its id and every edge stay (store spaces only — an
   * embedded field stores ids). `'id'`: re-id the group (a merge into a new id that carries the
   * node's label, payload and family rule). Default: `'label'` for a store space, `'id'` for an
   * embedded one.
   */
  readonly by?: 'label' | 'id';
}

export interface CreateOptions {
  /**
   * The groups the new item starts in: a list (for `defaultSpace`), or a list per space. Merged
   * with any ids already in the item's embedded fields.
   */
  readonly groups?: readonly string[] | Readonly<Record<string, readonly string[]>>;
}

/** The facade. Every write is serialized per instance and returns an {@link OperationResult}. */
export interface TaggedCollection<T extends Record<string, unknown>> {
  readonly provider: DataProvider<T>;
  readonly idField: string;
  /** The space names, in declaration order. */
  readonly spaceNames: readonly string[];
  readonly defaultSpace: string;

  /** (Re)load every space: re-read the records (embedded) and the stores. Operations load lazily on first use. */
  load(): Promise<void>;
  /** The current space (a `GroupSpace` — hand it to any projection). Throws before the first load. */
  space(name?: string): GroupSpace;
  /**
   * A `FilterExpression` for `provider.getList` selecting the items in `group` and its subgroups —
   * `scopeFilter` over an embedded space's field. Store spaces keep no field on the records to filter on.
   */
  scope(group: string, options?: SpaceOption & { readonly expand?: 'direct' | 'closure' }): FilterCondition;

  /** Create a record and its memberships. The record write and the edges succeed together or not at all. */
  create(item: Partial<T>, options?: CreateOptions): Promise<OperationResult<T>>;
  /** Put each item in `group` (bulk; per-item failures do not stop the others). */
  tag(ids: readonly string[], group: string, options?: TagOptions): Promise<OperationResult<T>>;
  /** Take each item out of `group`: its membership edges only (an associative `related` link stays). */
  untag(ids: readonly string[], group: string, options?: SpaceOption): Promise<OperationResult<T>>;
  /** Add and remove several groups on several items, as one operation (the tri-state selection editor). */
  bulkTag(ids: readonly string[], change: BulkTagChange): Promise<OperationResult<T>>;
  /** Membership only: `id` leaves `group`; the record, the group and the item's other groups stay. */
  removeFromGroup(id: string, group: string, options?: SpaceOption): Promise<OperationResult<T>>;
  /** The record and its memberships in every space. If it is itself a group with members, its node stays. */
  deleteItem(id: string): Promise<OperationResult<T>>;
  /** The group node and every edge touching it (tombstoned, so the inverse restores it whole). Members stay. */
  deleteGroup(group: string, options?: SpaceOption): Promise<OperationResult<T>>;
  /** Rename a group (see {@link RenameOptions.by}). */
  renameGroup(group: string, name: string, options?: RenameOptions): Promise<OperationResult<T>>;
  /** "`todo` and `to-do` are the same tag": re-point `from`'s memberships to `into`, then delete `from`. */
  mergeGroups(from: string, into: string, options?: SpaceOption): Promise<OperationResult<T>>;
  /** Ordered spaces: move `id` within `group` to just before or after another member (its rank only). */
  moveInGroup(id: string, group: string, options: MoveOptions): Promise<OperationResult<T>>;
  /** Apply an inverse. Same per-item semantics; returns the inverse of the revert (a redo). */
  revert(inverse: CollectionInverse<T>): Promise<OperationResult<T>>;

  /** Notified once per operation that changed something. A throwing listener is isolated. */
  subscribe(listener: (change: CollectionChange<T>) => void): () => void;

  /** The declarative operations, for renderers to list (each name is the last segment of its command's id). */
  readonly operations: readonly OperationDefinition[];
  /** The operations as commands in acture's `CommandRecord` shape, bound to this collection. */
  readonly commands: readonly GroupsCommand[];
}
