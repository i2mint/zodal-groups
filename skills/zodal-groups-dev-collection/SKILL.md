---
name: zodal-groups-dev-collection
description: Use when working on @zodal/groups-collection — the tagged-collection facade that keeps a zodal item collection (DataProvider records) and one or more group spaces consistent. Triggers on defineTaggedCollection, TaggedCollection, create-with-groups, tag / untag / bulkTag, removeFromGroup vs deleteItem vs deleteGroup, renameGroup, mergeGroups, revert, CollectionInverse, OperationResult { succeeded, failed }, compensation, per-item failure semantics, conflict retry with expectedRevision, embedded edges ({ embedded: 'tags' }), record edges, vocabulary, several spaces over one item universe (Zotero), the operations / commands export (acture CommandRecord shape), INVERSE_EFFECT, or adding a new collection operation. Read BEFORE changing the engine: the write order (rules, records, stores, caches) and the per-item split of the inverse are what make partial failure and undo correct.
metadata:
  audience: developers
---

# zodal-groups · the collection facade (`@zodal/groups-collection`)

`packages/groups-collection` — one CRUD object over item records (a `@zodal/store` `DataProvider`) and named group spaces over those items, kept consistent. It is the glue polytag's seam 2 needs ([polytag ADR 0001](https://github.com/i2mint/polytag/blob/main/docs/decisions/0001-placement-and-seams.md)); the decisions are reconciliation **D31** (§8.8). Depends on `groups-core` and on `@zodal/store`/`@zodal/core` **types** only — never `@zodal/ui`, never a store adapter (those are dev deps for tests).

## The layout

| file | what |
|---|---|
| `src/define.ts` | `defineTaggedCollection`: config checks, load, the op queue, and one **plan builder** per operation |
| `src/engine.ts` | `execute(plan)`: the write order and failure semantics, shared by every operation and by `revert` |
| `src/spaces.ts` | space runtimes — embedded (derived from records) and store (a `GroupStore`); `commit`, `deriveEmbedded`, `resyncEmbedded`, `nextField` |
| `src/delta.ts` | `partition` a delta by owning item, `combine` a subset back (pruning tombstones still touched) |
| `src/commands.ts` | `operations` (declarative) and `createCommands` (acture `CommandRecord` shape, shared ids) |

## A plan, and the engine's order

An operation is a **plan**: `units` (one per item, with an optional record op `create` / `delete`), the `spaces` it writes, and `build(rt, space, ids) → EdgeDelta` — the whole delta for those items, computed from the operation's **intent** against a given space (it is called again after a conflict, so never capture a snapshot in it). Group-level operations (rename by label, a store-space merge) have no units and a `subject`.

`execute` always runs:

1. **read** each unit's record (`notFound` drops it); embedded caches re-sync from what was read;
2. **dry run** each space — `applyDelta(current, build(...))` is pure validation. A violation whose `edge.child` or `node` is a unit drops that unit (and the rest are re-checked); any other violation refuses everything. A store space that refuses is reloaded once and re-checked (the refusal may be our stale view);
3. **record writes**, per unit (create / delete / the embedded field patch). A failure drops the unit — nothing to compensate;
4. **store writes**, ONE delta per space, with `expectedRevision` (+ `expectedEpoch` once an apply returned it). `conflict` → `loadStore`, re-validate (units the fresh state refuses are **abandoned**: record undone, earlier spaces' parts inverted), retry up to `maxRetries`. I/O error or exhausted retries abandon everything left;
5. **embedded caches** apply the delta for the units that made it;
6. the **inverse**, partitioned per unit.

**Records before edges** is deliberate: the common failure (a record write) then needs no compensation. Do not reorder it.

## The inverse is split per item

`CollectionInverse = { items: [{ id, record?, edges: { space: EdgeDelta }, fields? }], shared: { space: EdgeDelta }, expect: { space: Node[] } }` — plain JSON. `partition` assigns an edge to its **child** when the child is a unit, a node to itself when it is a unit; everything else (group nodes, group-to-group edges, tombstones of emptied groups) is `shared`. `revert` is just a plan whose `build` recombines the parts of the surviving units plus `shared`, so reverting has the same per-item semantics. `combine` drops a tombstone whose node is still touched (a group keeps the members that could not be moved). `expect` holds the nodes as the operation left them: a revert that would overwrite a newer change (a rename) is refused. `fields` holds embedded fields as they were: written verbatim on revert only if they still hold the same groups (order survives undo; a field changed since is never clobbered). A revert of a create (`record.op === 'delete'`) also drops every membership the item has *now* (as `deleteItem` does).

## Embedded spaces

- Derived on load: every record is a node; every id in its field is a **record edge** `group ⊃ record` with the deterministic id `recordEdgeId(group, item)` (`rec:` + JSON) — derivable from the record, so ids survive reloads and inverses stay valid. Vocabulary edges must not use the `rec:` prefix.
- The record is the source of truth: before writing, each record is re-read and the cache re-synced (`resyncEmbedded`); the field write is computed from the record's current value (`nextField`: added groups take the places of removed ones, the rest append; unknown entries kept; always a new array — 0.2.0's in-memory provider shares arrays).
- An emptied, bare group (not vocabulary, not a record) is tombstoned in the same delta (`collectEmptied`), because a reload would not derive it. A group that is also a record cannot be deleted/merged/re-id'd as a group (its node is the record's) → `unsupported`.
- `kind` is always `contains` (the field cannot say more); labels cannot be persisted → `renameGroup` defaults to `by: 'id'` there.

## Store spaces

Edge ids are minted unique (`uniqueEdgeId`), so an undo can never remove a newer edge under a reused id. The cache is the last space seen; `commit` uses the returned `space`, or applies the delta locally and checks the revision, else reloads. `load()` returns no epoch: it is learned from the first apply and dropped on reload.

## Adding an operation

1. Add the method to `TaggedCollection` (`types.ts`) and a plan builder in `define.ts`: units, spaces, `build` from intent. Use `perMember(full, members)` for a group-level delta whose members are records (embedded), `collectEmptied` after removals, `rt.mintEdge` for new edges.
2. Data-dependent refusals return `refuse(id, code, reason)`; programming errors throw.
3. Add it to `operations` and `commandParams` (JSON-Schema-representable Zod) in `commands.ts`, and a handler in `createCommands`.
4. Test it in `tests/operations.test.ts` — it runs over all three backings (embedded, memory store, fs store) and `undoable()` checks revert-then-redo restores the state exactly.

## Tests

`tests/helpers.ts`: `BACKINGS` (embedded / memory store / fs store in a temp dir), `flakyProvider` (fail `update`/`create`/`delete` per id, record calls), `interceptStore` (inject I/O errors or conflicts, count applies), `state(tc)` (records + every space, for exact equality). Files: `operations` (every op × backing, undo/redo exact), `failures` (mid-bulk record failure, compensation, inconsistent), `conflict` (two writers on memory and fs stores, conflict → violation, bounded retries, epoch), `rules` (family / caps / cycle refused before any record write), `spaces` (Zotero, round-trip load, scope, resync, config errors), `commands` (ids, effects, acture-undo-style host, isolated listeners).

## Do NOT

- ❌ Keep a history or add `tc.undo()`. Return inverses; the app's history owns undo (zgroups_05 §1.8).
- ❌ Apply N single-edge deltas for a bulk operation (O(N²), §8.6). One delta per space, partitioned.
- ❌ Write a store without `expectedRevision`, or retry by replaying the old delta: rebuild from intent and re-validate.
- ❌ Depend on `@zodal/ui`, acture, or a store adapter at runtime.
- ❌ Write an embedded field from the cache alone — re-read the record.
