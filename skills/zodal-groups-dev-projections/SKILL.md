---
name: zodal-groups-dev-projections
description: Use when working on any zodal-groups PROJECTION — projectTree/PathNode, projectColumns (Miller columns), breadcrumbs/allPaths/primaryPath, otherLocations, facetPanel/counts, scopeFilter, closure (ancestors/descendants/membersOf/countIn), or intensional "smart" groups. Triggers on "render the tree", "expansion state", "pathKey vs nodeId", "breadcrumb under multiple parents", "facet counts", "search within a group and its subgroups", "the tree opened in two places", "counts are double", "which parent am I viewing this under". Read BEFORE writing a projection or debugging a tree-state bug — the expansion/selection keying rule and the de-duplicated-count rule are the two things everyone gets wrong.
metadata:
  audience: developers
---

# zodal-groups · projections

A projection is a **pure function of `(space, options)`**. It never mutates, never touches the DOM,
and never caches (the host memoizes on `space.revision`, which is what that field is for).

Everything a user *looks at* is a projection. If you find yourself wanting to store a tree, stop —
you want to store edges and compute the tree.

## The two rules that everyone gets wrong

### 1. `pathKey` for the view; `nodeId` for the model

**A DAG node is not a row. A *path* to a node is a row.** If group `G` sits under both `A` and `B`,
the tree genuinely shows it twice — and those two rows are different things, because the user can
open one and leave the other closed.

| state | keyed by | why |
|---|---|---|
| **expansion** | `pathKey` | It is a *view* fact — "I opened this drawer", and there really are two drawers. |
| **selection** | `nodeId` | It is a *model* fact — "I chose this thing", and there is only one thing. |
| **DOM / React key** | `pathKey` | Duplicate DOM ids are invalid HTML and silently corrupt `aria-owns`, `aria-activedescendant`, and label associations. |

Get it backwards and you ship one of two bugs, both of which survive code review:

- expansion keyed by `nodeId` → opening a node **spontaneously opens it somewhere off-screen**;
- selection keyed by `pathKey` → selecting an item leaves its other appearances un-highlighted, so
  **the same thing looks like two things**.

### 2. Counts are a de-duplicated union over the closure — never `Σ children.count`

Under polyhierarchy an item can reach a group through two different subgroups, so summing child
counts **double-counts it**. Solr's documented default for multivalued fields does exactly this.

This is the worst class of bug: the number is *wrong*, not *broken*. Nobody notices for a year.

```ts
count(g) = |{ item : g ∈ ancestors*(item) }|   // a SET. Always.
```

## `PathNode[]` — the universal output

One flat, ordered array serves **tree view, treegrid, virtualization, ARIA, Miller columns, and
icicle charts**. That is not a coincidence: virtualization forces flatten-to-visible-rows, and ARIA
forces DAG-unfolding (see below), so the fast structure and the accessible structure are the same
structure.

```ts
interface PathNode {
  readonly nodeId: NodeId;            // model identity
  readonly pathKey: string;           // view identity — the join of `path`
  readonly path: readonly NodeId[];   // the ancestry that produced this row
  readonly depth: number;             // → aria-level (1-based: depth + 1)
  readonly label: string;             // edge label, falling back to node label
  readonly hasChildren: boolean;
  readonly childCount: number;
  readonly otherParentCount: number;  // > 0 ⇒ "also in N other groups"
  readonly isRecursive: boolean;      // cycle guard — render as a leaf. NOT optional.
  readonly edge?: Edge;
}
```

**`projectTree` is O(visible rows), not O(graph)** — only expanded rows contribute children. Safe to
call on every render and hand straight to a virtualizer.

## ARIA forces our hand, and it agrees with us

`aria-owns` explicitly forbids multiple owners: *"Do not specify the id of an element in more than
one other element's `aria-owns` attribute."* **The accessibility tree IS a tree, by construction.**

So the DAG must be unfolded into path-nodes *before* it reaches the DOM — and then `aria-level =
depth + 1` is unambiguous, **because the path is what got you here**. This is not a workaround; it is
the correct reading of the spec.

Multi-parenthood is then conveyed **semantically, never structurally**:

- accessible name: *"Reading, tree item, level 3, **also in 2 other groups**"*
- plus a keyboard command opening a **flat list** of the other locations (`otherLocations()`) — a
  linear, fully-navigable structure, which is strictly better than trying to make a tree say it.

## The projections

| function | returns | notes |
|---|---|---|
| `projectTree(space, opts)` | `PathNode[]` | the workhorse. `expanded: Set<pathKey>`. |
| `projectColumns(space, {trail})` | `Column[]` | **Miller columns. The whole view state is one array.** |
| `allPaths(space, node)` | `NodePath[]` | **capped** (default 32) — path count is exponential in depth. |
| `primaryPath(space, node)` | `NodePath?` | for URLs/deep links. `'shortest' \| 'first' \| fn`. |
| `breadcrumbs(space, node, {arrivedVia})` | `NodePath?` | **honour `arrivedVia`** — the route the user walked. |
| `otherLocations(space, node)` | `OtherLocation[]` | the affordance a tree cannot have. |
| `facetPanel(space, opts)` | `FacetValue[]` | de-duplicated counts; empty facets hidden. |
| `scopeFilter(space, group)` | a `FilterExpression` | **groups only**, never items. |
| `ancestors` / `descendants` | `Set<NodeId>` | memoized, cycle-safe, per-kind. |
| `membersOf(space, g, {expand})` | `NodeId[]` | `'direct' \| 'closure'` — **Zotero's checkbox**. |

## Prefer Miller columns as the default for a polyhierarchy

Counter-intuitive but well-supported: **the tree view survives polyhierarchy *least* well and costs
the most to get right**, while Miller columns, drill-down, and faceted browsing survive it natively.

**A column stack IS a path.** When the user has clicked `Archive → Research → Reading`, the question
"which of Reading's three parents am I viewing it under?" is answered by the screen — the column to
the left. The tree has to *invent* an answer, then key its expansion correctly, then explain itself
to a screen reader. The column browser never asks the question.

(Mark Miller himself generalized the technique to directed graphs. And Google Drive *abolished*
multi-parenting in 2020 rather than teach it through a folder tree — a signal about presentation, not
about the model.)

## Search × hierarchy

- **Within a facet: OR. Across facets: AND.** Hearst: "a conjunct of disjuncts". Selecting a
  hierarchical label means *"a disjunction over all the labels beneath it"* — picking `animal` must
  match an item tagged only `poodle`. That is `closureIds`, and it is why the closure engine exists.
- **`scopeFilter` needs no new `FilterOperator`.** Expand the group to its descendant *groups*, then
  hand the id set to the existing `arrayContainsAny` — which maps to Postgres `&&`, PostgREST `ov`,
  and Dexie `anyOf`. (An earlier plan added a `descendantOf` operator to `@zodal/core`. **Not
  needed.** Don't re-add it.)
- **Disjunctive facet counts require N+1 queries** — one per selected facet, with *that facet's own*
  filter removed. Skip it and every unselected option reads zero, turning the panel into a dead end.
  It is architectural (Meilisearch, Solr `excludeTags`, Algolia all confirm), not a flag.

## Do NOT

- ❌ Key expansion by `nodeId`, or the DOM by `nodeId`.
- ❌ Sum child counts.
- ❌ Call `allPaths` uncapped.
- ❌ Assume acyclicity in a projection. `isRecursive` is mandatory — we don't own our data.
- ❌ Put the *gesture* in the descriptor. A projection says what the groups are, never whether they
  open in a panel or expand in place. One model, many navigation styles.
- ❌ Cache a projection inside core. Return pure data; let the host memoize on `revision`.

## Routing

- Navigation patterns, ARIA, the keying rule: `docs/research/zgroups_03-*`
- Facet internals, closure strategy: `docs/research/zgroups_02-*`
- The merged decisions: [`docs/research/_reconciliation.md`](../../docs/research/_reconciliation.md) (D12, D13, D17)
