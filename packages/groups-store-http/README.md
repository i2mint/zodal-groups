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

One revisioned JSON document per URL. It is small enough to implement in any backend.

| Request | Answer |
|---|---|
| `GET url` | `200 { revision, epoch?, snapshot }`, or `404` when there is no document yet |
| `PUT url` with `{ baseRevision, revision, epoch, snapshot }` | `200 { revision, epoch }` if the stored revision is `baseRevision` (0 for none) and, when the document has an epoch, `epoch` matches it; else `409 { current: document \| null }`, writing nothing |

- `snapshot` is `{ nodes, edges }`, as `toSnapshot` writes it.
- `epoch` is the document's history id. The first client to write it mints the id; it stays the same for the document's lifetime, and a document that is deleted and re-created gets a new one. That way, a revision number from an older history can never match by accident.
- The server checks structure only. The profile is the client's: it is code, not data.
- `memorySnapshotEndpoint()` is the reference server, written as a `fetch` function. Pass it as `fetch` in tests, or read it as the spec.

## Options

`url`, `profile` / `overrides`, `fetch` (default: the global one; pass one that adds auth or retries), `headers` (an object, or a function called per request, e.g. for a fresh token), `maxReplays` (default 3), `keepalive` (send writes with `keepalive`, so a write started in `pagehide` completes; browsers cap such a body at 64 KiB, so only for small spaces), `onListenerError`.

The store also has `loadVersioned()`, which returns `{ space, epoch }` from one read, and `subscribe(listener)`, which fires after each successful write. Errors other than 409 (a 500, a malformed document) reject with an `HttpStoreError` that carries the `status`.

## Replaying local work: `rebase`

```ts
const { space, applied, refused } = rebase(remoteSpace, pendingDeltas);
```

`rebase` replays deltas you queued locally (offline, or before a 409) on top of a newer remote space. It first makes each delta idempotent: an added edge the remote already has (same parent, child and kind) is dropped, and so is a removal of an edge the remote no longer has. A delta the model then refuses, such as a cycle the remote made possible, is skipped and reported in `refused`.

## Notes

- Whole-snapshot writes fit a taxonomy plus the memberships of a few thousand items. For millions of edges, use a delta endpoint or a database store.
- Do not seed item nodes into the space only to give them display labels: they would be persisted. Give renderers a `labelOf` instead.
