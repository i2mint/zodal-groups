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
| `undo()` | free — every write is a delta |

## Rendering

The core is headless: it emits `PathNode[]`, a flat array that serves tree views, Miller columns,
virtualization, ARIA, and icicle charts alike.

```ts
import { renderColumns, renderTree, renderTagInput } from '@zodal/groups-ui-vanilla';
import '@zodal/groups-ui-vanilla/styles.css';

renderColumns(el, g);   // Miller columns — the best view for a polyhierarchy
renderTree(el, g);      // tree — correct ARIA, twins cross-highlighted
renderTagInput(el, g);  // tag chips — the same edges, projected flat
```

**Drag-and-drop defaults to ADD, not MOVE.** Moving destroys an edge the user often can't see, and is
undefined when dragging out of a search result. Hold ⌥ to move. (Gmail's `Label` vs `Move to`.)

| package | what |
|---|---|
| `@zodal/groups-core` | the model, profiles, closure, projections |
| `@zodal/groups-ui` | headless view descriptors, drag intent, renderer registry |
| `@zodal/groups-ui-vanilla` | zero-dependency DOM renderers |

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

Core and headless UI are built and tested. Store adapters (Postgres/Supabase, filesystem, Dexie) and
the shadcn/Ark renderers are next.

## License

MIT
