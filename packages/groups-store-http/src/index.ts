/**
 * `@zodal/groups-store-http` — a `GroupStore` over an HTTP snapshot endpoint.
 *
 * For a browser app that keeps its group space on its own server. The server holds ONE revisioned
 * JSON document; the store reads it, applies each delta locally (validated against the profile,
 * with its exact inverse), and writes the whole snapshot back with the revision it was made from.
 * When another writer got there first the server answers 409 with its current document, and the
 * store replays the delta on top of it — or, if the caller pinned a revision, reports `conflict`.
 *
 * ```ts
 * const store = createHttpGroupStore({ url: '/api/groups', profile: 'labels' });
 * const space = await store.load();
 * await store.apply({ added: [makeEdge(nodeId('work'), nodeId('a'))] });
 * ```
 *
 * **The protocol** (small enough for any backend — Python, Supabase, a worker):
 *
 * - `GET url` → `200 { revision, epoch?, snapshot }`, or `404` when there is no document yet.
 * - `PUT url` with `{ baseRevision, revision, epoch, snapshot }` → the server stores the document
 *   iff its current revision is `baseRevision` (0 when it has none) and, when it has an epoch,
 *   `epoch` matches it; it answers `200 { revision, epoch }`. Otherwise
 *   `409 { current: { revision, epoch?, snapshot } | null }`, writing nothing.
 *
 * `epoch` is the document's history id: minted by the first client that writes it, kept for its
 * lifetime, new if the document is deleted and re-created (so a stale `expectedRevision` from an
 * older history never matches by accident). `memorySnapshotEndpoint()` is the reference server, as
 * a `fetch` function — use it in tests, or read it as the spec.
 *
 * Every `load` and every `apply` reads the document first, so a write is never computed from a
 * stale copy; applies are serialized per store. Snapshots are whole-document writes: fine for a
 * taxonomy plus memberships of a few thousand items, not for millions of edges (use a delta
 * endpoint or a database store there).
 */

import {
  CLIENT_SIDE_CAPABILITIES,
  applyDelta,
  commitDelta,
  createListenerSet,
  edgesInto,
  fromSnapshot,
  newEpoch,
  parseSnapshot,
  readonlySpace,
  toSnapshot,
  type EdgeDelta,
  type GroupProfile,
  type GroupSnapshot,
  type GroupSpace,
  type GroupStore,
  type GroupStoreChange,
  type ProfileName,
  type Result,
  type StoreApplied,
  type StoreLoaded,
  type Violation,
} from '@zodal/groups-core';

// ── the wire ────────────────────────────────────────────────────────────────

/** What the endpoint holds, and what `GET` returns. */
export interface SnapshotDocument<P = unknown> {
  readonly revision: number;
  readonly epoch?: string;
  readonly snapshot: GroupSnapshot<P>;
}

/** The body of a `PUT`. */
export interface SnapshotPut<P = unknown> {
  /** The revision this write was computed from (0: the document did not exist). */
  readonly baseRevision: number;
  readonly revision: number;
  readonly epoch: string;
  readonly snapshot: GroupSnapshot<P>;
}

/** The body of a `409`. */
export interface SnapshotConflict<P = unknown> {
  readonly current: SnapshotDocument<P> | null;
}

/** The endpoint answered something the protocol does not allow (a 500, a body that is not a document). */
export class HttpStoreError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HttpStoreError';
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ── the store ───────────────────────────────────────────────────────────────

export interface HttpGroupStoreOptions {
  /** The document's URL: `GET` reads it, `PUT` writes it. */
  readonly url: string;
  /** The profile every write is validated against. Defaults to `polyhierarchy`. */
  readonly profile?: ProfileName | GroupProfile;
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  /** Defaults to the global `fetch`. Pass one that adds auth, or `memorySnapshotEndpoint()` in tests. */
  readonly fetch?: FetchLike;
  /** Sent with every request (e.g. `Authorization`). A function is called per request. */
  readonly headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * How many times an `apply` without `expectedRevision` replays itself on a newer document after a
   * 409 before it reports `conflict`. Default 3.
   */
  readonly maxReplays?: number;
  /**
   * Send writes with `keepalive`, so a write started in `pagehide` still completes. Browsers cap a
   * keepalive body at 64 KiB, so only for small spaces. Default `false`.
   */
  readonly keepalive?: boolean;
  /** Where a throwing `subscribe` listener's error goes. Defaults to `console.error`. */
  readonly onListenerError?: (error: unknown) => void;
}

/** A `GroupStore` over one HTTP snapshot document. */
export interface HttpGroupStore<P = unknown> extends GroupStore<P> {
  readonly url: string;
  loadVersioned(): Promise<StoreLoaded<P>>;
}

export function createHttpGroupStore<P = unknown>(options: HttpGroupStoreOptions): HttpGroupStore<P> {
  const { url, maxReplays = 3, keepalive = false } = options;
  const doFetch: FetchLike =
    options.fetch ??
    ((input, init) => {
      if (typeof globalThis.fetch !== 'function') {
        throw new HttpStoreError('createHttpGroupStore: no global fetch here; pass `fetch`.');
      }
      return globalThis.fetch(input, init);
    });
  const profileOptions = {
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  };
  const empty = fromSnapshot<P>({ nodes: [], edges: [] }, profileOptions);
  const profile = empty.profile;
  const listeners = createListenerSet<GroupStoreChange>(options.onListenerError);

  const headers = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => {
    const base = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
    return { accept: 'application/json', ...base, ...extra };
  };

  const toLoaded = (doc: SnapshotDocument<P> | null): StoreLoaded<P> & { readonly revision: number } => {
    if (!doc) return { space: empty, epoch: undefined, revision: 0 };
    const space = fromSnapshot<P>({ ...doc.snapshot, revision: doc.revision }, profileOptions);
    return { space, epoch: doc.epoch, revision: doc.revision };
  };

  const read = async (): Promise<StoreLoaded<P> & { readonly revision: number }> => {
    const response = await doFetch(url, { method: 'GET', headers: await headers() });
    if (response.status === 404) return toLoaded(null);
    if (!response.ok) throw new HttpStoreError(`GET ${url}: ${response.status} ${response.statusText}`, response.status);
    return toLoaded(parseDocument<P>(await response.json(), `GET ${url}`));
  };

  type PutOutcome = { readonly ok: true; readonly revision: number; readonly epoch: string } | { readonly ok: false; readonly current: SnapshotDocument<P> | null };
  const write = async (body: SnapshotPut<P>): Promise<PutOutcome> => {
    const response = await doFetch(url, {
      method: 'PUT',
      headers: await headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (response.status === 409) {
      const payload = (await response.json().catch(() => ({}))) as { current?: unknown };
      return { ok: false, current: payload.current == null ? null : parseDocument<P>(payload.current, `PUT ${url} (409)`) };
    }
    if (!response.ok) throw new HttpStoreError(`PUT ${url}: ${response.status} ${response.statusText}`, response.status);
    const payload = (await response.json().catch(() => ({}))) as { revision?: unknown; epoch?: unknown };
    return {
      ok: true,
      revision: typeof payload.revision === 'number' ? payload.revision : body.revision,
      epoch: typeof payload.epoch === 'string' && payload.epoch ? payload.epoch : body.epoch,
    };
  };

  // Applies are serialized: each reads the document, then writes it.
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };

  const applyOnce = async (
    delta: EdgeDelta,
    applyOptions: { expectedRevision?: number; expectedEpoch?: string },
  ): Promise<Result<StoreApplied<P>>> => {
    let base = await read();
    for (let attempt = 0; ; attempt++) {
      // A document without an epoch (new, or written before epochs) starts a history here.
      const epoch = base.epoch ?? newEpoch();
      const result = commitDelta(base.space, delta, applyOptions, epoch);
      if (!result.ok) return result;
      const next = result.value.space;
      const put = await write({ baseRevision: base.revision, revision: next.revision, epoch, snapshot: snapshotOf(next) });
      if (put.ok) {
        const space = readonlySpace(put.revision === next.revision ? next : fromSnapshot<P>({ ...toSnapshot(next), revision: put.revision }, profileOptions));
        listeners.emit({ delta, inverse: result.value.inverse, revision: put.revision, epoch: put.epoch });
        return { ok: true, value: { revision: put.revision, inverse: result.value.inverse, epoch: put.epoch, space } };
      }
      // Someone else wrote first: replay on their document. A write pinned to a revision then
      // fails `commitDelta`'s check above with `conflict`, as it should.
      base = toLoaded(put.current);
      if (attempt >= maxReplays) return { ok: false, violations: [conflictViolation(base.revision, applyOptions.expectedRevision)] };
    }
  };

  return {
    url,
    profile,
    load: async () => readonlySpace((await serialized(read)).space),
    loadVersioned: async () => {
      const { space, epoch } = await serialized(read);
      return { space: readonlySpace(space), epoch };
    },
    apply: (delta, applyOptions) => serialized(() => applyOnce(delta, applyOptions ?? {})),
    getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
    subscribe: (listener) => listeners.add(listener),
    dispose: () => listeners.clear(),
  };
}

function conflictViolation(actualRevision: number, expectedRevision?: number): Violation {
  return {
    code: 'conflict',
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    actualRevision,
    message: `Another writer kept changing the document (now at revision ${actualRevision}). Nothing was written; re-read and retry.`,
  } as Violation;
}

/** The snapshot to send: plain data, no revision (the document carries it). */
function snapshotOf<P>(space: GroupSpace<P>): GroupSnapshot<P> {
  const { nodes, edges } = toSnapshot(space);
  return { nodes, edges };
}

/** Validate a document from the wire. */
export function parseDocument<P = unknown>(value: unknown, where = 'document'): SnapshotDocument<P> {
  if (!value || typeof value !== 'object') throw new HttpStoreError(`${where}: expected { revision, snapshot }, got ${typeof value}`);
  const record = value as { revision?: unknown; epoch?: unknown; snapshot?: unknown };
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 0) {
    throw new HttpStoreError(`${where}: "revision" must be a non-negative integer, got ${JSON.stringify(record.revision)}`);
  }
  if (record.epoch !== undefined && (typeof record.epoch !== 'string' || record.epoch === '')) {
    throw new HttpStoreError(`${where}: "epoch" must be a non-empty string, got ${JSON.stringify(record.epoch)}`);
  }
  let snapshot: GroupSnapshot<P>;
  try {
    snapshot = parseSnapshot<P>(record.snapshot);
  } catch (error) {
    throw new HttpStoreError(`${where}: malformed snapshot: ${(error as Error).message}`, undefined, { cause: error });
  }
  return { revision: record.revision, ...(record.epoch !== undefined ? { epoch: record.epoch as string } : {}), snapshot };
}

// ── replay ──────────────────────────────────────────────────────────────────

export interface RebaseResult<P> {
  /** `remote` with every pending delta that still applies. */
  readonly space: GroupSpace<P>;
  /** The deltas that applied, as applied (already-present edges and already-gone removals dropped). */
  readonly applied: readonly EdgeDelta[];
  /** The deltas the model refused on the new base, with why. */
  readonly refused: readonly { readonly delta: EdgeDelta; readonly violations: readonly Violation[] }[];
}

/**
 * Replay local deltas on top of a newer remote space — what a client does after a 409, or after
 * being offline. Each delta is made idempotent first: an added edge the remote already has (same
 * parent, child and kind) is dropped, and so is a removal of an edge the remote no longer has. A
 * delta the model then refuses (a cycle the remote made possible, a cap) is skipped and reported.
 */
export function rebase<P>(remote: GroupSpace<P>, pending: Iterable<EdgeDelta>): RebaseResult<P> {
  let space = remote;
  const applied: EdgeDelta[] = [];
  const refused: { delta: EdgeDelta; violations: readonly Violation[] }[] = [];
  for (const delta of pending) {
    const added = (delta.added ?? []).filter(
      (e) => !space.edges.has(e.id) && !edgesInto(space, e.child).some((x) => x.parent === e.parent && x.kind === e.kind),
    );
    const removed = (delta.removed ?? []).filter((id) => space.edges.has(id));
    const removedNodes = (delta.removedNodes ?? []).filter((n) => space.nodes.has(n.id));
    const effective: EdgeDelta = {
      ...delta,
      added,
      removed,
      ...(delta.removedNodes ? { removedNodes } : {}),
    };
    const result = applyDelta(space, effective);
    if (result.ok) {
      space = result.value;
      applied.push(effective);
    } else {
      refused.push({ delta, violations: result.violations });
    }
  }
  return { space, applied, refused };
}

// ── the reference server ────────────────────────────────────────────────────

export interface MemorySnapshotEndpoint extends FetchLike {
  /** The stored document (`null`: none yet). */
  readonly document: SnapshotDocument | null;
  /** Replace the stored document as is (a foreign writer, a seed); `null` deletes it. */
  set(document: SnapshotDocument | null): void;
}

/**
 * The protocol's reference server, in memory, as a `fetch` function: pass it as
 * `createHttpGroupStore({ url, fetch })`. It serves any URL; one endpoint is one document.
 */
export function memorySnapshotEndpoint(initial: SnapshotDocument | null = null): MemorySnapshotEndpoint {
  let document: SnapshotDocument | null = initial;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const endpoint = (async (_input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return document ? json(200, document) : json(404, { error: 'no document' });
    if (method !== 'PUT') return json(405, { error: `${method} not allowed` });
    let body: SnapshotPut;
    try {
      body = JSON.parse(String(init?.body)) as SnapshotPut;
      parseDocument({ revision: body.revision, epoch: body.epoch, snapshot: body.snapshot }, 'PUT body');
    } catch (error) {
      return json(400, { error: (error as Error).message });
    }
    const currentRevision = document?.revision ?? 0;
    const epochOk = !document?.epoch || document.epoch === body.epoch;
    if (body.baseRevision !== currentRevision || !epochOk || typeof body.epoch !== 'string' || !body.epoch) {
      return json(409, { current: document });
    }
    document = { revision: body.revision, epoch: body.epoch, snapshot: body.snapshot };
    return json(200, { revision: document.revision, epoch: document.epoch });
  }) as MemorySnapshotEndpoint;

  Object.defineProperty(endpoint, 'document', { get: () => document });
  endpoint.set = (next) => {
    document = next;
  };
  return endpoint;
}
