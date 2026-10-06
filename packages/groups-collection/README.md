# @zodal/groups-collection

**One CRUD object over a zodal item collection and its memberships** — create an item in groups, tag and untag in bulk, rename, merge, delete a group or an item — with the records and the group spaces kept consistent, and every operation returning the inverse that undoes it.

```bash
npm install @zodal/groups-collection @zodal/groups-core @zodal/store @zodal/core zod
```

```ts
import { defineTaggedCollection } from '@zodal/groups-collection';
import { createInMemoryProvider } from '@zodal/store';

const tc = defineTaggedCollection({
  provider: createInMemoryProvider([{ id: 'a', title: 'Alpha', tags: [] }, { id: 'b', title: 'Beta', tags: ['work'] }]),
  spaces: { tags: { profile: 'flatTags', edges: { embedded: 'tags' } } },
});

const r = await tc.tag(['a', 'b'], 'urgent');   // → { ok, succeeded: ['a', 'b'], failed: [], inverse }
await tc.revert(r.inverse);                      // undo: your app's history calls this
tc.space('tags');                                // a GroupSpace — hand it to any groups-core projection
```

## Spaces: where the edges live

A collection has one or more named **spaces** over the same items (Zotero's collections *and* tags, over one library). Each space keeps its edges in one of two places:

| `edges` | stored | good for |
|---|---|---|
| `{ embedded: 'tags' }` | a `string[]` of group ids on each record; the space is derived from the records on load | flat tags and labels over any `DataProvider`; `tc.scope(group)` gives a filter the provider runs (`arrayContainsAny`) |
| a `GroupStore` (`createMemoryGroupStore`, `@zodal/groups-store-fs`, …) | the store | group-to-group nesting, edge kinds, labels and order on edges, group nodes with labels and family rules |

```ts
import { createFsGroupStore } from '@zodal/groups-store-fs';

const tc = defineTaggedCollection({
  provider,
  spaces: {
    tags:        { profile: 'flatTags', edges: { embedded: 'tags' } },
    collections: { edges: createFsGroupStore({ path: './library/.collections.json', profile: 'polyhierarchy' }) },
  },
});
await tc.tag(ids, 'reading', { space: 'collections' });       // `space` defaults to the first one declared
await tc.create({ id: 'paper-7', title: '…' }, { groups: { tags: ['to-read'], collections: ['reading'] } });
```

Without `spaces`, you get one embedded space on a `groups` field — what `scopeFilter` already assumes. An embedded space may declare a `vocabulary` (group nodes with labels and `family` rules, group-to-group edges) in code; it is held in memory, never persisted, because a record can only carry its own memberships.

## Operations

| operation | does |
|---|---|
| `create(item, { groups })` | the record and its memberships, together |
| `tag(ids, group)` / `untag(ids, group)` | bulk add / remove one group |
| `bulkTag(ids, { add, remove })` | several groups on several items, one operation (the tri-state selection editor) |
| `removeFromGroup(id, group)` | **membership only** — the record, the group and the item's other groups stay |
| `deleteItem(id)` | the record and its memberships in every space |
| `deleteGroup(group)` | the group node and every edge touching it (tombstoned); the members stay |
| `renameGroup(group, name, { by })` | `by: 'label'` sets the node's label (store spaces; the default there); `by: 'id'` re-ids it (embedded: the default — the field stores ids) |
| `mergeGroups(from, into)` | re-point `from`'s memberships to `into` (no duplicates), delete `from` |
| `revert(inverse)` | apply an inverse; returns the inverse of that (a redo) |

Operations on one instance run one at a time. Programming errors (an unknown space, an edge kind an embedded field cannot store) reject; everything that depends on the data is reported in the result.

## Failure semantics

- **Rules first.** Profile caps, family cardinality (`EXCLUSIVE` families) and acyclicity are checked with a dry run of the delta *before any record is written*. A violation that belongs to one item fails that item; one about a group (a rule no single item breaks) refuses the operation.
- **Per item, all or nothing.** An item's record write and its edges succeed together or are compensated. Records are written first, so a failed record write needs no compensation; a store write that fails after the records were written undoes them (deletes a created record, re-creates a deleted one, restores a field).
- **Bulk keeps what succeeded.** `{ ok, succeeded, failed: [{ id, code, reason, violations? }], inverse }` — the inverse undoes exactly the applied part. A group operation whose member could not be updated keeps the group, holding that member; running it again completes it.
- **Concurrent writers.** Every `GroupStore` write carries `expectedRevision` (and `expectedEpoch` once known). On `conflict` the space is reloaded, the delta rebuilt from the operation's intent, re-validated, and retried — `maxRetries` times (default 3). An item the fresh state refuses fails alone.
- **Never overwrite a newer change on undo.** A revert re-validates against the current state: a tombstone must match the live node, a rename is not undone over someone else's later rename, an embedded field is restored verbatim only if it still holds the same groups.

`failed[i].inconsistent: true` marks the one case left: a write succeeded, a later one failed, and the compensation failed too. The reason names the half left over.

## Undo lives in your history

No history is kept here (zgroups_05 §1.8: do not build a separate undo subsystem). Every result has an `inverse` — plain data, split per item — and `revert(inverse)` applies it with the same per-item semantics. Store inverses in whatever history the app has.

## Operations and commands

`operations` is the declarative `OperationDefinition[]` (from `@zodal/core`) a renderer lists; `tc.commands` are the same operations in [acture](https://github.com/thorwhalen/acture)'s `CommandRecord` shape — `{ id, title, params: Zod, execute → Result }`, ids like `groups.mergeGroups` (`commandNamespace` sets the prefix). No acture dependency. A command's result carries the operation result as `value` and the inverse as an effect, which acture-undo routes back on undo:

```ts
for (const cmd of tc.commands) registry.register(defineCommand(cmd));        // acture

const redo = new WeakMap();
createUndoHistory(adapter, registry, {
  onEffect: async (effect, { isUndo, isRedo }) => {
    if (effect.type !== INVERSE_EFFECT) return;
    if (isUndo) redo.set(effect, (await tc.revert(effect.inverse)).inverse);
    if (isRedo) await tc.revert(redo.get(effect));
  },
});
```

A command whose every item failed returns `{ ok: false, error: { code, message, details: { failed } } }`; a partial success is `ok: true` with `value.failed` non-empty (partial stays applied). `deleteItem` and `deleteGroup` are `confirm: true` in `operations`, but acture has no confirmation step: gate them with `when` if a palette or an AI caller must not run them unprompted.

## Change notifications

`tc.subscribe(listener)` is called once per operation that changed something, with `{ operation, result }`. A throwing listener is isolated (`onListenerError`, default `console.error`).

## Limits

- **Embedded spaces assume one writer between loads**: each record an operation rewrites is re-read first (so a field changed elsewhere is never overwritten), but other changes are seen on `tc.load()`.
- **A group that is also a record** (an item others are tagged with) cannot be deleted, merged away or re-id'd as a group in an embedded space — its node is the record's. Untag its members, or `deleteItem` it.
- **Store spaces keep no field on the records**, so `scope()` is embedded-only; use `closureIds(tc.space(name), group)` and filter by id.

Part of [zodal-groups](https://github.com/i2mint/zodal-groups), the grouping specialization of [zodal](https://github.com/i2mint/zodal). MIT.
