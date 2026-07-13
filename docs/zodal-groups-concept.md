# zodal-groups

**One line:** A declarative layer where *membership* is the canonical data, and every folder tree,
tag cloud, facet browser and breadcrumb is a **projection** over it.

## Essence

`zodal-groups` is the **grouping/classification specialization** of `zodal`. Where `zodal` lets you
declare a collection's shape and capabilities once (via Zod) and generates UI, state, data-access
and API interfaces from that declaration, `zodal-groups` does the same for *organized* data: declare
how things may be grouped, and let pluggable backends and renderers realize that organization.

It gives you the thing folders and subfolders are good at — **hierarchical organization** — without
the thing folders are bad at: **"an item can only be in one place."**

## The problem it solves

Every application eventually needs to organize items. Today you pick one of these, early, and you
are stuck with it:

- **folders** — nesting, but an item lives in exactly one place;
- **tags** — many-membership, but flat, and you can't tag a tag;
- **categories** — a tree of them, but items attach at one node;
- **facets** — great for search, but usually bolted on separately from the browse hierarchy.

These are not four data models. **They are four *projections* of one data model**, plus four
different sets of restrictions. `zodal-groups` names that model, and makes the restrictions a
parameter.

## The core abstraction — three layers

1. **Model** — one canonical relation: a set of reified **membership edges**
   `{ parent, child, kind, label?, order? }`. A node may be an item, a group, or both. Nothing else
   is authoritative.
2. **Affordances** — the declared catalog of what you can *do* and *see*: group/ungroup, re-parent,
   tag, ancestors/descendants, "what other groups is this in?", breadcrumbs, facet counts, scoped
   search, drag-to-add-parent. Pure declaration — no implementation baked in. A **profile** says
   which of these are legal.
3. **Targets** — pluggable bindings. A **UI renderer** (tree, Miller columns, breadcrumbs, tag
   input, facet panel, icicle), a **store adapter** (in-memory, filesystem, Postgres/Supabase, S3),
   or a **query target** (where a scoped search compiles to a `FilterExpression`).

## The one idea

> **The hierarchy is a view, not a fact.**

Store the edges. Compute the trees.

This is not a clever reframing; it is what the systems that got this right already do. Unix
filesystems already let a file live in many directories (hard links) — what they forbid is
hard-linked *directories*, purely so the directory graph stays acyclic and refcount GC terminates.
Zotero ships the whole idea as a checkbox (`View → Show Items from Subcollections`): the same edges
render as strict containment or closure-expanded, depending on a view flag. Are.na goes furthest —
blocks live in unlimited channels, channels *are* blocks, and *"This channel appears in"* is a
first-class reverse index.

What none of them do is let you **choose the restrictions**.

## Profiles — one model, named restrictions, each buying a guarantee

The framing is borrowed from OWL 2 Profiles; the ladder is Z39.19's, from 2005.

| you want… | profile | what it means |
|---|---|---|
| folders & subfolders | `filesystem` | `maxParentsPerItem: 1, maxParentsPerGroup: 1` |
| flat tags, no tagging-of-tags | `flatTags` | `maxDepth: 0, groupsMayContainGroups: false` |
| nested tags (Obsidian-style, but with real edges) | `nestedTags` | `maxParentsPerGroup: 1` |
| Gmail labels | `labels` | items multi-parent; the label tree is a tree |
| the general case | `polyhierarchy` | acyclic, otherwise unrestricted |
| a real thesaurus | `thesaurus` | typed edge kinds (`is_a` / `part_of` / `related`) |

A filesystem and a tag cloud are the *same object* with different `maxParents`. That is the whole
pitch.

## The facade in action

One declaration, many realizations:

| Affordance | Tree renderer | Miller columns | Facet panel | Postgres target |
|---|---|---|---|---|
| `descendants(g)` | expand the node | push a column | the drill-down subtree | recursive CTE (via RPC) |
| `membersOf(g, {expand:'closure'})` | show sub-items inline | list the column | the result set | `groups && ARRAY[...]` |
| `otherLocations(i)` | ghost-highlight the twins | "also in 3 channels" | — | reverse index lookup |
| `addParent(i, g)` | drag-drop (default) | drag between columns | click a facet | one edge insert |

The caller asks for the operation; the active target decides how.

## Design commitments

- **Membership is canonical; everything else is a projection.** (The thesis. Everything follows.)
- **Facade + SSOT** — declare once; derive downstream.
- **Open-closed via adapters** — new renderers/stores plug in without touching the model.
- **Honest capability reporting** — an adapter says truthfully whether it does transitive closure
  natively, and *what happens on delete* (not a boolean — see the reconciliation).
- **Headless first** — the core emits configuration objects (`PathNode[]`), never DOM.
- **Progressive disclosure** — `flatTags` users never see a `parents` field.
- **Acyclic on write; cycle-safe on read** — we enforce the invariant, but never *trust* it, because
  the data arrives from adapters that never heard of it.
- **Don't reinvent the wheel** — adapters wrap existing tools. But: **no library computes a
  path-keyed DAG unfolding, and every library can render one.** That gap is exactly what the core
  owns.

## What it is — and isn't

It **is** a declaration-and-mapping layer for organizing items: a place to express membership and
bind it to trees, columns, facets, and stores.

It **is not** a graph database, a search engine, or a general graph library. If you need cycles,
arbitrary edges, and graph algorithms, you want [`zodal-graphs`](../../zodal-graphs). `zodal-groups`
is the *acyclic, containment-shaped* special case — and it is a special case precisely so that
closure, counts, and breadcrumbs can be well-defined.
