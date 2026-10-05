/**
 * `GroupStore` — the persistence contract for a group space, and its in-memory default.
 *
 * A store does three things, all shaped around the one write primitive:
 *
 * 1. **`load()`** — the persisted space (nodes + edges, with its indexes). Not validated against the
 *    profile: it is the read path, and stored data may predate the profile (D8).
 * 2. **`apply(delta, { expectedRevision? })`** — validate an `EdgeDelta` against the profile and
 *    the acyclicity invariant, persist it atomically, and resolve to `{ revision, inverse, space? }`.
 *    The **inverse is computed inside the store's serialized section, against the state the delta
 *    was actually applied to** — a caller computing it from its own earlier read would undo against
 *    the wrong state. `expectedRevision` is optimistic concurrency: if the store has moved on, the
 *    write is refused with a `conflict` violation and nothing is written (so a compensating undo
 *    can never clobber another writer's change). `space` is optional because a backend over a large
 *    membership relation cannot return the whole space without reading it all (D10). A violation
 *    is an ordinary outcome (`{ ok: false }`, with the offending path for a cycle); only an I/O
 *    failure rejects the promise.
 * 3. **`getCapabilities()`** — what the backend does natively, as a record rather than a boolean
 *    (D19): above all, what happens to closure on *delete*.
 *
 * `subscribe` is optional; a store that offers it notifies once per successful `apply`, and a
 * throwing listener never breaks the write or the other listeners.
 *
 * The profile is code, not data: the store is constructed with one and validates every write with
 * it, but does not persist it. The same edges under a different profile are the same edges.
 *
 * Every adapter runs the shared contract kit, `groupStoreContract` from
 * `@zodal/groups-core/testing`.
 *
 * @see `docs/research/_reconciliation.md` — D7, D9, D10, D19, D28; §6.
 */

import type { EdgeDelta, Edge, GroupSpace, Node, NodeId, Result } from './model.js';
import type { GroupProfile, ProfileName } from './profile.js';
import { applyDelta, createGroupSpace, invert } from './space.js';
import { fromSnapshot, readonlySpace, type GroupSnapshot } from './snapshot.js';

/**
 * Honest capability reporting — a record, not a boolean (D19).
 *
 * `supportsClosure: boolean` is meaningless without saying what happens on delete: incremental
 * closure maintenance must not drop `(1,4)` when edge `3→4` goes if `1→2→4` still exists (the
 * `path_count`/DRed problem).
 */
export interface GroupStoreCapabilities {
  readonly closure: {
    /**
     * `'native'`: the store answers closure queries itself (a recursive CTE, a closure table) via
     * `GroupStore.closureIds`. `'client'`: the caller computes closure over the loaded space
     * (`closureIds` from groups-core) — perfectly fine, since the group DAG is small (D10).
     */
    readonly read: 'native' | 'client';
    /** Does the closure the store serves reflect an insert as soon as `apply` resolves? */
    readonly maintainedOnInsert: boolean;
    /**
     * After a delete: `'exact'` (always correct — including a client-side walk, which has no cache
     * to go stale), `'rebuild'` (correct, by rebuilding the group-DAG closure), or `'unsupported'`
     * (stale until something else rebuilds it).
     */
    readonly maintainedOnDelete: 'exact' | 'rebuild' | 'unsupported';
  };
  /**
   * Does the store persist `Edge.order` (and keep binary, not locale, collation for it)? The kit
   * checks it: a store that says `true` must round-trip `order`.
   *
   * (Facet-count flags — server-side counts, disjunctive N+1 counts — are deliberately absent until
   * a store has a method that serves them: a flag no method backs is a promise nobody can test.
   * They return with an optional `facetCounts` method and a kit case; see reconciliation D28.)
   */
  readonly ordering: boolean;
}

/** A change notification from a store. */
export interface GroupStoreChange {
  readonly delta: EdgeDelta;
  /** The delta that undoes this change, against the state it was applied to. */
  readonly inverse: EdgeDelta;
  readonly revision: number;
}

/** Options for `GroupStore.apply`. */
export interface StoreApplyOptions {
  /**
   * Apply only if the store is at exactly this revision; otherwise refuse with `conflict` and write
   * nothing. Pass the revision your undo or compensation was computed against.
   */
  readonly expectedRevision?: number;
}

/** What a successful `GroupStore.apply` returns. */
export interface StoreApplied<P = unknown> {
  /** The store's revision after this write. */
  readonly revision: number;
  /** Undoes exactly this write. Apply it with `expectedRevision: revision` to undo safely. */
  readonly inverse: EdgeDelta;
  /** The whole new space — only from a store that holds it anyway (memory, a manifest). */
  readonly space?: GroupSpace<P>;
}

/**
 * The in-memory heart of a store's `apply`: check `expectedRevision`, compute the inverse against
 * `space`, apply. A store calls it inside its serialized section, on the state it just read.
 */
export function commitDelta<P>(
  space: GroupSpace<P>,
  delta: EdgeDelta,
  options: StoreApplyOptions = {},
): Result<StoreApplied<P> & { readonly space: GroupSpace<P> }> {
  const expected = options.expectedRevision;
  if (expected !== undefined && expected !== space.revision) {
    return {
      ok: false,
      violations: [
        {
          code: 'conflict',
          expectedRevision: expected,
          actualRevision: space.revision,
          message: `The store is at revision ${space.revision}, not ${expected}: another write landed first. Nothing was written; re-read and retry.`,
        },
      ],
    };
  }
  const inverse = invert(space, delta);
  const result = applyDelta(space, delta);
  if (!result.ok) return result;
  return { ok: true, value: { revision: result.value.revision, inverse, space: result.value } };
}

/** The persistence contract. See the module docstring. */
export interface GroupStore<P = unknown> {
  /** The profile every `apply` is validated against. */
  readonly profile: GroupProfile;
  /** The persisted space. Waits for any `apply` already in flight. */
  load(): Promise<GroupSpace<P>>;
  /**
   * Validate and persist atomically; return the new revision and the exact inverse — or the
   * violations (including `conflict` for a stale `expectedRevision`), writing nothing.
   */
  apply(delta: EdgeDelta, options?: StoreApplyOptions): Promise<Result<StoreApplied<P>>>;
  getCapabilities(): GroupStoreCapabilities;
  /** Present iff `getCapabilities().closure.read === 'native'`: `group` plus its descendants. */
  closureIds?(group: NodeId): Promise<NodeId[]>;
  /** Optional change stream. Returns an unsubscribe function. */
  subscribe?(listener: (change: GroupStoreChange) => void): () => void;
  /** Release what the store holds (listeners, handles, connections). Optional; idempotent. */
  dispose?(): void | Promise<void>;
}

/** The capabilities of a store that holds the whole space in memory and walks closure client-side. */
export const CLIENT_SIDE_CAPABILITIES: GroupStoreCapabilities = Object.freeze({
  closure: Object.freeze({ read: 'client', maintainedOnInsert: true, maintainedOnDelete: 'exact' }),
  ordering: true,
}) as GroupStoreCapabilities;

/**
 * A listener set whose `emit` isolates throwing listeners: each is called in its own try/catch and
 * its error goes to `onListenerError`, so one bad subscriber cannot break a write or starve the
 * others (the zodal-dials lesson).
 */
export function createListenerSet<C>(
  onListenerError: (error: unknown) => void = defaultListenerError,
): { add(listener: (change: C) => void): () => void; emit(change: C): void; clear(): void } {
  const listeners = new Set<(change: C) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
    emit(change) {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
  };
}

function defaultListenerError(error: unknown): void {
  console.error('[zodal-groups] a GroupStore listener threw:', error);
}

export interface MemoryGroupStoreOptions<P> {
  readonly profile?: ProfileName | GroupProfile;
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  /** Seed data, validated against the profile (throws if it violates it, like `createGroupSpace`). */
  readonly nodes?: readonly Node<P>[];
  readonly edges?: readonly Edge[];
  /**
   * Seed with a snapshot AS IS — not validated, as if a foreign tool had written it (D8: the read
   * path must work on data that breaks the profile). Exclusive with `nodes`/`edges`.
   */
  readonly snapshot?: GroupSnapshot<P>;
  /** Where a throwing `subscribe` listener's error goes. Defaults to `console.error`. */
  readonly onListenerError?: (error: unknown) => void;
}

/**
 * The default `GroupStore`: the space, in memory. A real store, not a stub — it validates every
 * write, keeps a revision, notifies subscribers, and passes the contract kit. It is what a
 * `GroupStore`-shaped seam should default to when nothing needs to outlive the page.
 */
export function createMemoryGroupStore<P = unknown>(options: MemoryGroupStoreOptions<P> = {}): GroupStore<P> {
  const profileOptions = {
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  };
  if (options.snapshot && (options.nodes || options.edges)) {
    throw new Error('createMemoryGroupStore: pass either `snapshot` or `nodes`/`edges`, not both.');
  }
  let space = options.snapshot
    ? fromSnapshot<P>(options.snapshot, profileOptions)
    : createGroupSpace<P>({
        ...profileOptions,
        ...(options.nodes ? { nodes: options.nodes } : {}),
        ...(options.edges ? { edges: options.edges } : {}),
      });
  // What callers get: a read-only view, so nobody can mutate the store's state through `load()`.
  let view = readonlySpace(space);
  const listeners = createListenerSet<GroupStoreChange>(options.onListenerError);

  return {
    get profile() {
      return space.profile;
    },
    async load() {
      return view;
    },
    async apply(delta, applyOptions) {
      const result = commitDelta(space, delta, applyOptions);
      if (!result.ok) return result;
      space = result.value.space;
      view = readonlySpace(space);
      listeners.emit({ delta, inverse: result.value.inverse, revision: space.revision });
      return { ok: true, value: { ...result.value, space: view } };
    },
    getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
    subscribe: (listener) => listeners.add(listener),
    dispose: () => listeners.clear(),
  };
}
