/**
 * `GroupStore` — the persistence contract for a group space, and its in-memory default.
 *
 * A store does three things, all shaped around the one write primitive:
 *
 * 1. **`load()`** — the persisted space (nodes + edges, with its indexes). Not validated against the
 *    profile: it is the read path, and stored data may predate the profile (D8).
 * 2. **`apply(delta)`** — validate an `EdgeDelta` against the profile and the acyclicity invariant,
 *    persist it atomically, and resolve to the same `Result` as `applyDelta`. A violation (a cycle,
 *    a profile cap, a family rule) is an ordinary outcome and comes back as `{ ok: false }` with the
 *    offending path; only an I/O failure rejects the promise.
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
import { applyDelta, createGroupSpace } from './space.js';

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
  /** Does the backend count facet values itself? */
  readonly serverFacetCounts: boolean;
  /**
   * Correct DISJUNCTIVE facet counts need one query per selected facet with that facet's own filter
   * removed (N+1). That is architectural, not a flag: `'n-plus-one'` if the store can run them,
   * `'unsupported'` if not.
   */
  readonly disjunctiveFacetCounts: 'n-plus-one' | 'unsupported';
  /** Does the store persist `Edge.order` (and keep binary, not locale, collation for it)? */
  readonly ordering: boolean;
}

/** A change notification from a store. */
export interface GroupStoreChange {
  readonly delta: EdgeDelta;
  readonly revision: number;
}

/** The persistence contract. See the module docstring. */
export interface GroupStore<P = unknown> {
  /** The profile every `apply` is validated against. */
  readonly profile: GroupProfile;
  /** The persisted space. Waits for any `apply` already in flight. */
  load(): Promise<GroupSpace<P>>;
  /** Validate, persist atomically, and return the new space — or the violations, writing nothing. */
  apply(delta: EdgeDelta): Promise<Result<GroupSpace<P>>>;
  getCapabilities(): GroupStoreCapabilities;
  /** Present iff `getCapabilities().closure.read === 'native'`: `group` plus its descendants. */
  closureIds?(group: NodeId): Promise<NodeId[]>;
  /** Optional change stream. Returns an unsubscribe function. */
  subscribe?(listener: (change: GroupStoreChange) => void): () => void;
}

/** The capabilities of a store that holds the whole space in memory and walks closure client-side. */
export const CLIENT_SIDE_CAPABILITIES: GroupStoreCapabilities = Object.freeze({
  closure: Object.freeze({ read: 'client', maintainedOnInsert: true, maintainedOnDelete: 'exact' }),
  serverFacetCounts: false,
  disjunctiveFacetCounts: 'n-plus-one',
  ordering: true,
}) as GroupStoreCapabilities;

/**
 * A listener set whose `emit` isolates throwing listeners: each is called in its own try/catch and
 * its error goes to `onListenerError`, so one bad subscriber cannot break a write or starve the
 * others (the zodal-dials lesson).
 */
export function createListenerSet<C>(
  onListenerError: (error: unknown) => void = defaultListenerError,
): { add(listener: (change: C) => void): () => void; emit(change: C): void } {
  const listeners = new Set<(change: C) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
  /** Where a throwing `subscribe` listener's error goes. Defaults to `console.error`. */
  readonly onListenerError?: (error: unknown) => void;
}

/**
 * The default `GroupStore`: the space, in memory. A real store, not a stub — it validates every
 * write, keeps a revision, notifies subscribers, and passes the contract kit. It is what a
 * `GroupStore`-shaped seam should default to when nothing needs to outlive the page.
 */
export function createMemoryGroupStore<P = unknown>(options: MemoryGroupStoreOptions<P> = {}): GroupStore<P> {
  let space = createGroupSpace<P>({
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.nodes ? { nodes: options.nodes } : {}),
    ...(options.edges ? { edges: options.edges } : {}),
  });
  const listeners = createListenerSet<GroupStoreChange>(options.onListenerError);

  return {
    get profile() {
      return space.profile;
    },
    async load() {
      return space;
    },
    async apply(delta) {
      const result = applyDelta(space, delta);
      if (result.ok) {
        space = result.value;
        listeners.emit({ delta, revision: space.revision });
      }
      return result;
    },
    getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
    subscribe: (listener) => listeners.add(listener),
  };
}
