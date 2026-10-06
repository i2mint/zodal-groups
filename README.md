# zodal-groups

**Folders and subfolders — without "an item can only be in one place."**

```bash
npm install @zodal/groups-core
```

```ts
import { defineGroups } from '@zodal/groups-core';

const g = defineGroups({ profile: 'labels' });   // Gmail semantics

g.add('msg-1', 'work');
g.add('msg-1', 'urgent');       // the same message, in two groups. Not a copy.

g.otherLocations('msg-1');      // → "also in: work, urgent"
g.tree();                       // → PathNode[] — hand to any renderer
g.scope('work');                // → a filter: everything in `work` OR any subgroup
```

## The idea

Every app eventually needs to organize things, and you pick one of these early and get stuck:

- **folders** — nesting, but an item lives in exactly one place;
- **tags** — many per item, but flat, and you can't tag a tag;
- **categories** — a tree of them, but items attach at one node;
- **facets** — great for search, bolted on separately from browsing.

**These are not four data models. They are four *projections* of one model**, plus four different
sets of restrictions.

`zodal-groups` stores the one model — a flat set of **membership edges** — and computes the rest.
The hierarchy is a *view*, not a fact.

## Profiles — one model, named restrictions

```ts
defineGroups({ profile: 'filesystem' })     // an item lives in exactly one place
defineGroups({ profile: 'flatTags' })       // many tags per item; no tagging of tags
defineGroups({ profile: 'labels' })         // Gmail: items multi-parent, label tree is a tree
defineGroups({ profile: 'polyhierarchy' })  // the general case
defineGroups({ profile: 'thesaurus' })      // typed edges: is_a / part_of / related

// or dial it yourself — the hybrid case
defineGroups({ profile: 'polyhierarchy', overrides: { maxDepth: 3, maxGroupsPerItem: 5 } })
```

A filesystem and a tag cloud are the same object with a different `maxParentsPerItem`. That's the
whole pitch, and it's [an executable test](packages/groups-core/tests/profiles.test.ts).

## What you get that a tree can't give you

| | |
|---|---|
| `otherLocations(item)` | *"This is also in 3 other groups"* — meaningless in a tree, essential here |
| `paths(node)` | every route to a node, not just one |
| `count(g, {expand:'closure'})` | de-duplicated — an item reachable two ways is counted **once** |
| `canAdd(child, parent)` | *why* a drop is refused: *"That would create a loop: Reading → Research → Archive → Reading"* |
| `scope(group)` | search this group **and its subgroups**, as a `FilterExpression` |
| `undo()` | free — every write is a delta, and a deleted group comes back whole |
| `{ id: 'status', family: EXCLUSIVE }` | an exclusive family: at most one status per item — the board-column rule |
| `inferProfile(space)` | what shape is this data *actually* in? The tightest profile it fits, with evidence |

## Rendering

The core is headless: it emits `PathNode[]`, a flat array that serves tree views, Miller columns,
virtualization, ARIA, and icicle charts alike.

```ts
import { renderColumns, renderTree, renderTagInput, renderTagMenu } from '@zodal/groups-ui-vanilla';
import '@zodal/groups-ui-vanilla/styles.css';

renderColumns(el, g);   // Miller columns — the best view for a polyhierarchy
renderTree(el, g);      // tree — correct ARIA, twins cross-highlighted
renderTagInput(el, g);  // tag chips — the same edges, projected flat
renderTagMenu(el, g, { selection: ['a', 'b', 'c'] });  // Gmail's label menu over a selection
```

**Drag-and-drop defaults to ADD, not MOVE.** Moving destroys an edge the user often can't see, and is
undefined when dragging out of a search result. Hold ⌥ to move. (Gmail's `Label` vs `Move to`.)

### Tagging a selection

Select some items, open the menu: each group is checked (every selected item is in it), empty (none is) or **mixed** (some are). A click stages a change — a mixed box goes to *all*, as in Gmail — and nothing is written until **Apply to N items**. Before the click, the menu already says why a group would be refused (*"“Status” allows one value per item, and “Bug 12” would be in both “Todo” and “Doing”. Remove it from “Todo” first."*). The headless part lives in `@zodal/groups-ui` and never writes: it hands you a plan.

```ts
import { createTaggingSession } from '@zodal/groups-ui';

const menu = createTaggingSession(() => tc.space('tags'), {
  selection: ['a', 'b', 'c'],
  storesLabels: tc.storesLabels('tags'), // false for an embedded space: it stores group ids only
});
menu.view().rows;          // [{ group, label, state: 'none' | 'some' | 'all', count, disabled, reason, … }]
menu.toggle('urgent');     // some → all
const plan = menu.apply(); // { add: [{ group, ids }], remove: [...], batches, refused, conflicts }
const results = await Promise.all(plan.batches.map((b) => tc.bulkTag(b.ids, b.change)));
menu.complete(results);    // → "Applied: tagged 2 items, 1 refused: …" (for a live region)
```

Every `Violation` code has a sentence and a suggested fix (`explainViolation`), from one table a host can override or translate.

## Persisting

A `GroupStore` loads a space, applies deltas (validated, atomically) and reports what it does natively. The in-memory one ships with the core; the filesystem one keeps everything in one sidecar JSON manifest — never in symlinks.

```ts
import { createFsGroupStore } from '@zodal/groups-store-fs';

const store = createFsGroupStore({ path: './photos/.groups.json', profile: 'labels' });
const r = await store.apply(delta);  // → { ok: true, value: { revision, epoch, inverse } } or { ok: false, violations }
// A safe undo: refused (`conflict`) if anyone wrote since. Without these options, the last write wins.
if (r.ok) await store.apply(r.value.inverse, { expectedRevision: r.value.revision, expectedEpoch: r.value.epoch });
const space = await store.load();    // hand it to any projection
```

Deleting a group is undoable too: the delta carries the deleted node as a tombstone, so `invert` brings back its label, payload and edges. Writing an adapter? Run the shared contract kit, `groupStoreContract` from `@zodal/groups-core/testing`.

## Items and their groups, together

`@zodal/groups-collection` is one CRUD object over a zodal item collection (any `DataProvider`) and one or more group spaces over those items — the edges on the records (`{ embedded: 'tags' }`) or in a `GroupStore`. Rules are checked before anything is written, a record and its edges succeed together, a bulk operation keeps what succeeded and reports the rest, and every operation returns its inverse for your app's undo history.

```ts
import { defineTaggedCollection } from '@zodal/groups-collection';

const tc = defineTaggedCollection({ provider, spaces: { tags: { profile: 'flatTags', edges: { embedded: 'tags' } } } });
const r = await tc.tag(['a', 'b'], 'urgent');   // → { ok, succeeded, failed, inverse }
await tc.mergeGroups('todo', 'to-do');
await tc.revert(r.inverse);
tc.commands;                                    // the same operations as acture-shaped commands
```

## Packages

| package | what | status |
|---|---|---|
| `@zodal/groups-core` | the model, profiles, closure, projections, `GroupStore` contract + memory store, contract kit (`/testing`) | built |
| `@zodal/groups-ui` | headless view descriptors, drag intent, selection tagging (tri-state, staged, plan), violation messages, renderer registry | built |
| `@zodal/groups-ui-vanilla` | zero-dependency DOM renderers, including the selection tagging menu | built |
| `@zodal/groups-store-fs` | Node: the DAG and memberships in a sidecar JSON manifest, written atomically | built |
| `@zodal/groups-collection` | one CRUD object over an item collection and its group spaces: create-with-groups, bulk tag, rename, merge, delete; per-item failure semantics; inverses; acture-shaped commands | built |
| `@zodal/groups-store-indexeddb` | browser: `multiEntry` index on the membership set | TODO |
| `@zodal/groups-store-supabase` | Postgres: recursive CTE via RPC, GIN on memberships | TODO |

## Why the design is what it is

The short version — the long version is in [`docs/research/`](docs/research/), five reports and ~264
cited sources:

- **Unix already did this.** A file may be hard-linked into many directories. What's forbidden is
  hard-linked *directories* — purely to keep the graph acyclic. "One place" is a *profile*, not a law.
- **Closure belongs to the edge *kind*.** A wheel is `part_of` a car; a car `is_a` a vehicle; **a
  wheel is not a vehicle.** That's why SKOS makes `broader` non-transitive, and why we ship edge
  kinds.
- **A node under two parents is two rows, one thing.** Expansion is keyed by path; selection by node.
  Get it backwards and the tree opens itself in places you're not looking.
- **Counts must be de-duplicated sets.** Summing child counts gives an answer that is *wrong*, not
  *broken* — which is why it survives in production for years.
- **Nested sets can't do this.** Not "slowly" — *structurally*: one interval = one position = one
  parent. It's the first answer a search will give you. It's the wrong one.

## Status

Core, headless UI, the vanilla renderers, the filesystem store and the collection facade are built and tested. The IndexedDB and Supabase stores and the shadcn/Ark renderers are next.

## License

MIT
