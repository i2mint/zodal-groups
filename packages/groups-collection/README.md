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
| `{ embedded: 'tags' }` | a `string[]` of group ids on each record; the space is derived from the records on load. `order: 'sorted'` keeps the field sorted (binary order); the default keeps insertion order | flat tags and labels over any `DataProvider`; `tc.scope(group)` gives a filter the provider runs (`arrayContainsAny`) |
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

Without `spaces`, you get one embedded space on a `groups` field — what `scopeFilter` already assumes. An embedded space may declare a `vocabulary` (group nodes with labels and `family` rules, group-to-group edges) in code; it is held in memory, never persisted, because a record can only carry its own memberships — so deleting, merging away or renaming a vocabulary group is refused (`unsupported`): change it in code.

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
| `tag(ids, group, { position: { before \| after } })`, `moveInGroup(id, group, { before \| after })` | ordered spaces (a `GroupStore` whose profile is `ordered`): place or move members by fractional rank (`orderBetween`); a plain `tag` appends |
| `revert(inverse)` | apply an inverse; returns the inverse of that (a redo) |

Operations on one instance run one at a time. Programming errors (an unknown space, an edge kind an embedded field cannot store) reject; everything that depends on the data is reported in the result.

## Failure semantics

- **Rules first.** Profile caps, family cardinality (`EXCLUSIVE` families) and acyclicity are checked with a dry run of the delta *before any record is written*. A violation that belongs to one item fails that item; one about a group (a rule no single item breaks) refuses the operation.
- **Per item, all or nothing.** An item's record write and its edges succeed together or are compensated. Records are written first, so a failed record write needs no compensation; a store write that fails after the records were written undoes them (deletes a created record, re-creates a deleted one, restores a field).
- **Bulk keeps what succeeded.** `{ ok, succeeded, failed: [{ id, code, reason, violations? }], inverse }` — the inverse undoes exactly the applied part. A delete or merge whose member could not be updated keeps the group, holding that member; running it again completes it. A rename by id that moved only some members already created the new group (with the old one's fields), so re-running it reports `groupExists` and says how to finish: `mergeGroups(from, to)`.
- **Concurrent writers.** Every `GroupStore` write carries `expectedRevision` (and `expectedEpoch` once known). On `conflict` the space is reloaded (after an exponential, jittered backoff from `retryDelayMs`), the delta rebuilt from the operation's intent, re-validated, and retried — `maxRetries` times (default 3). An item the fresh state refuses fails alone.
- **A store that throws is re-read before anyone is compensated.** A store may commit and then throw (the fs store releases its lock after the rename). The facade re-reads it and decides by revision and by the delta's own (unique) edge ids whether the write landed; if it cannot tell, the item is failed and flagged `inconsistent`.
- **Embedded spaces assume one writer per record.** Each record is re-read before it is rewritten and read back after; if a concurrent write replaced the field, the item is failed (`conflict`, `inconsistent`) and the next operation sees the record as it is.
- **Never overwrite a newer change on undo.** A revert re-validates against the current state, and refuses an item (`conflict`) when: a tombstone no longer matches the live node; a group it would re-add a member to was deleted since (unless the inverse itself restores it); a node it would restore was changed since (a later rename); or an embedded field no longer holds what the operation left, for a group the revert touches. A store revert whose target state already holds is a no-op success. An embedded field is restored verbatim (order and all) when it still names the same groups.

`failed[i].inconsistent: true` marks what is left: a write succeeded, a later one failed, and the compensation failed too (or it cannot be known whether a store write landed). The reason names the half left over.

## Undo lives in your history

No history is kept here (zgroups_05 §1.8: do not build a separate undo subsystem). Every result has an `inverse` — plain data, split per item — and `revert(inverse)` applies it with the same per-item semantics. Store inverses in whatever history the app has.

## Operations and commands

`operations` is the declarative `OperationDefinition[]` (from `@zodal/core`) a renderer lists; `tc.commands` are the same operations in [acture](https://github.com/thorwhalen/acture)'s `CommandRecord` shape — `{ id, title, params: Zod, execute → Result }`, ids like `groups.mergeGroups` (`commandNamespace` sets the prefix). No acture dependency. A command's result carries the operation result as `value` and the inverse as an effect, `{ type: INVERSE_EFFECT, inverse, collection }`, which acture-undo routes back on undo. `collection` is the command namespace: **when an app has several collections, give each its own `commandNamespace`** and route by it:

```ts
const notes = defineTaggedCollection({ provider: notesProvider, commandNamespace: 'notes' });
const files = defineTaggedCollection({ provider: filesProvider, commandNamespace: 'files' });
const byNamespace = { notes, files };
for (const cmd of [...notes.commands, ...files.commands]) registry.register(defineCommand(cmd));   // acture

const redo = new WeakMap();
createUndoHistory(adapter, registry, {
  onEffect: async (effect, { isUndo, isRedo }) => {
    if (effect.type !== INVERSE_EFFECT) return;
    const tc = byNamespace[effect.collection];
    if (isUndo) redo.set(effect, (await tc.revert(effect.inverse)).inverse);
    if (isRedo) await tc.revert(redo.get(effect));
  },
});
```

A command whose every item failed returns `{ ok: false, error: { code, message, details: { failed } } }`; a partial success is `ok: true` with `value.failed` non-empty (partial stays applied). `deleteItem` and `deleteGroup` are `confirm: true` in `operations`, but acture has no confirmation step: gate them with `when` if a palette or an AI caller must not run them unprompted.

## Change notifications

`tc.subscribe(listener)` is called once per operation that changed something, with `{ operation, result }`. A throwing listener is isolated (`onListenerError`, default `console.error`).

## Limits

- **Embedded spaces assume one writer per record**: each record an operation rewrites is re-read before and after the write (a lost write is reported, never believed), but other changes to the space are seen on `tc.load()`.
- **A group that is also a record** (an item others are tagged with), or that comes from the code-declared vocabulary, cannot be deleted, merged away or re-id'd as a group in an embedded space. Untag its members, `deleteItem` the record, or change the vocabulary in code.
- **Ranks need a store**: an embedded field orders its ids per *item*; a rank within a *group* lives on the edge, so `position` and `moveInGroup` need an ordered `GroupStore` space.
- **Store spaces keep no field on the records**, so `scope()` is embedded-only; use `closureIds(tc.space(name), group)` and filter by id.

Part of [zodal-groups](https://github.com/i2mint/zodal-groups), the grouping specialization of [zodal](https://github.com/i2mint/zodal). MIT.
