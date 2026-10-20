# @zodal/groups-store-http

A `GroupStore` for [zodal-groups](https://github.com/i2mint/zodal-groups) over an HTTP snapshot endpoint: for a browser app that keeps its group space on its own server.

```ts
import { createHttpGroupStore } from '@zodal/groups-store-http';
import { makeEdge, nodeId } from '@zodal/groups-core';

const store = createHttpGroupStore({ url: '/api/groups', profile: 'labels' });
const space = await store.load();
const r = await store.apply({ added: [makeEdge(nodeId('work'), nodeId('a'))] });
if (r.ok) undoStack.push({ delta: r.value.inverse, expectedRevision: r.value.revision, expectedEpoch: r.value.epoch });
```

Each `apply` reads the document, validates the delta against the profile (cycles, caps, families), computes its exact inverse, and writes the whole snapshot back with the revision it was made from. If another writer got there first, the server answers 409 with its current document. The store then replays the delta on top of it, up to `maxReplays` times (default 3). A write pinned with `expectedRevision` / `expectedEpoch` is reported as `conflict` instead. Applies on one store are serialized, so a delta queued while a save is in flight waits its turn. It passes the shared `groupStoreContract` kit.

## The protocol

The protocol is one revisioned JSON document per URL. It is small enough to implement in any backend.

| Request | Answer |
|---|---|
| `GET url` | `200 { revision, epoch?, snapshot }`, or `404`, which means there is no document yet (a mistyped URL therefore loads an empty space) |
| `PUT url` with `{ baseRevision, revision, epoch, snapshot }` | `200 { revision, epoch }` when the write is stored; `409 { current }` when it is not; `400` for a malformed body |

What the server must do for a `PUT`:

1. **Validate, else answer 400.** `epoch` must be a non-empty string, `revision` must equal `baseRevision + 1`, and `snapshot` must be `{ nodes, edges }` as `toSnapshot` writes it.
2. **Compare and set, atomically** (one transaction, or a conditional update). Store the body iff the current revision is `baseRevision` (0 when there is no document) and, when the stored document has an epoch, `epoch` equals it. Two clients creating the document at `baseRevision: 0` must not both win, so use a unique row or a transaction.
3. **Answer.** On success, return `200 { revision, epoch }` with exactly the values it stored; the client rejects anything else. On a refused write, return `409` whose body always has `current`: the stored document, or `null` when there is none. A `409` without `current` (from a proxy, say) is an error, not a refusal.

Further rules:

- `revision` and `epoch` are the document's. `revision` is a safe integer. `epoch` is the history id: minted by the client that writes the document first, kept for the document's lifetime, and new when the document is deleted and re-created. That way, a revision number from an older history can never match by accident.
  - A legacy document without an epoch accepts any epoch, and that write sets it. Until then, the history guard is off.
- The server checks structure only. The profile is the client's: it is code, not data.
- Send `Cache-Control: no-store` on the document. The client also reads with `cache: 'no-store'`, because a write must never be computed from a cached copy.
- Cross-origin: a `PUT` with `content-type: application/json` or an `authorization` header triggers a CORS preflight, so allow `GET, PUT` and those headers.
- `memorySnapshotEndpoint()` is the reference server, written as a `fetch` function. Pass it as `fetch` in tests, or read it as the spec.

```http
PUT /api/groups
content-type: application/json

{"baseRevision": 3, "revision": 4, "epoch": "8d1c…", "snapshot": {"nodes": [], "edges": [{"id": "e1", "parent": "work", "child": "a", "kind": "contains"}]}}

HTTP/1.1 200 OK
{"revision": 4, "epoch": "8d1c…"}
```

## Options

- `url`.
- `profile` / `overrides`.
- `fetch`: defaults to the global one. Pass your own for cookies across origins (`credentials: 'include'`), timeouts (`AbortSignal.timeout`) or retries.
- `headers`: any `HeadersInit`, or a function called per request (e.g. for a fresh token). These win over the defaults, whatever their case.
- `maxReplays`: a non-negative integer, default 3.
- `keepalive`: sends writes with `keepalive`, so a `PUT` already in flight when the page is hidden still completes. It does not start new work: an `apply` reads first, and that needs the page alive. Browsers cap a keepalive body at 64 KiB, and a larger one rejects.
- `onListenerError`.

The store also has `loadVersioned()`, which returns `{ space, epoch }` from one read, and `subscribe(listener)`, which fires after each successful write. Errors other than a protocol 409 (a 500, a body that is not JSON, a malformed document, a server that answers values it was not sent) reject with an `HttpStoreError` that carries the `status`. Error messages name the URL without credentials, query or fragment.

## Replaying local work: `rebase`

```ts
const { space, applied, refused } = rebase(remoteSpace, pendingDeltas);
```

`rebase` replays deltas you queued locally (offline, or before a 409) on top of a newer remote space. It first makes each delta idempotent: an added edge the remote already has (same parent, child and kind) is dropped, and so is a removal of an edge the remote no longer has. A delta the model then refuses, such as a cycle the remote made possible, is skipped and reported in `refused`.

## Notes

- Whole-snapshot writes fit a taxonomy plus the memberships of a few thousand items. For millions of edges, use a delta endpoint or a database store.
- A write whose response is lost (the request reached the server, the answer did not) may be retried by the caller. It is then re-applied on the stored document, and is not idempotent. Deterministic edge ids make the duplicate visible as a violation.
- Do not seed item nodes into the space only to give them display labels: they would be persisted. Give renderers a `labelOf` instead.
