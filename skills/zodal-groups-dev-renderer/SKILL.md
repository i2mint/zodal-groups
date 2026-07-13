---
name: zodal-groups-dev-renderer
description: Use when building or changing a zodal-groups UI RENDERER package (@zodal/groups-ui-vanilla, -shadcn, -ark, or a new one) — tree, Miller columns, breadcrumbs, facet panel, tag input, tree-select, icicle. Triggers on "add a renderer", "render the group tree", "drag and drop a folder", "add-vs-move", "drop target", "which tree library should we use", "virtualize the tree", "tree accessibility", "renderer registry", "PRIORITY bands". Read BEFORE adding a renderer or a UI dependency — the add-vs-move default and the DOM-keying rule are safety issues, and several popular tree/DnD libraries are dead, paid, or silently single-parent.
metadata:
  audience: developers
---

# zodal-groups · UI renderers

A renderer consumes **`TreeRow[]` / `Column[]` / `FacetRow[]`** from `@zodal/groups-ui` and draws
them. It computes nothing about the graph. If you are writing graph logic inside a renderer, it
belongs in `groups-core` — put it there and let every renderer benefit.

The reference implementation is `@zodal/groups-ui-vanilla` (~150 lines for a fully accessible,
drag-and-droppable, polyhierarchy-correct tree). **Read `packages/groups-ui-vanilla/src/tree.ts`
before writing a new one.** Its brevity is the evidence that the projection layer is carrying its
weight — if your renderer is much bigger, you are probably re-deriving something.

## The three rules a renderer must not break

### 1. The DOM key is `row.key` (the **pathKey**), never `row.nodeId`

A node under two parents renders twice. Keying by `nodeId` produces **duplicate DOM ids** — invalid
HTML, which silently corrupts `aria-owns`, `aria-activedescendant`, and label associations.

```ts
li.dataset.key    = row.key;      // ✅ path — the view identity
li.dataset.nodeId = row.nodeId;   // for selection/membership ops only
```

Correspondingly: **expansion is keyed by `pathKey`, selection by `nodeId`.** (See
`zodal-groups-dev-projections` for why this is the *correct* split rather than a compromise.)

### 2. Drag-and-drop defaults to **ADD**, not MOVE

This is the most dangerous interaction in the library, and we deliberately invert Finder:

- **ADD** — give the node another parent. It is now in both places. Nothing is lost. ← **default**
- **MOVE** — remove it from where it was. **An edge is destroyed.** ← requires ⌥/Alt

Three reasons, in increasing order of importance:

1. MOVE destroys an edge the user often **cannot see** (the source group may be off-screen).
2. MOVE is literally **undefined** when the drag starts from a search result or a flat "all items"
   list — there is no source group to remove from. ADD always has a meaning.
3. The undo cost is asymmetric: an accidental ADD is visible and obvious; an accidental MOVE silently
   removes something from a folder nobody was looking at.

Gmail is the precedent, and it removes the ambiguity by refusing to have it: **two verbs, `Label` and
`Move to`.** When you have room for two buttons, use two buttons (`MEMBERSHIP_ACTIONS`).

Use `resolveDrop()` — never hand-roll this:

```ts
const drop = resolveDrop(groups, { source: row.source, target: hovered.source,
                                   modifiers: { alt: e.altKey } });
li.classList.toggle('is-drop-valid',   drop.valid && !drop.destructive);
li.classList.toggle('is-drop-move',    drop.valid &&  drop.destructive);  // style it DIFFERENTLY
li.classList.toggle('is-drop-invalid', !drop.valid);
li.title = drop.reason ?? '…';
if (drop.valid) e.preventDefault();
```

### 3. An invalid drop must say **why**

In a tree, illegal drop targets are visibly inside the thing you're dragging. **In a DAG, a cycle can
close through an off-screen branch — so the user cannot see why it's illegal**, and a target that
just refuses is indistinguishable from a bug.

`drop.reason` gives you the sentence: *"That would create a loop: Reading → Research → Archive →
Reading."* Render it. Without it, correct cycle prevention *looks* broken.

## Accessibility is not optional here

Every row must carry `aria-level`, `aria-posinset`, `aria-setsize`, `aria-selected`, and (when it has
children) `aria-expanded`. `toTreeRows` computes all of them into `row.aria` — just spread them on.

Why mandatory: any tree that scales gets virtualized, virtualization forces a **flat DOM**, and a flat
DOM conveys no depth structurally. `aria-owns` also forbids multiple owners, so the a11y tree is a
tree by construction — which is exactly why we unfold to path-nodes first.

Multi-parenthood goes in the **accessible name** (`row.aria.label` already contains *"also in 2 other
groups"*), plus a keyboard command opening the flat `otherLocations()` list. Never try to express two
parents structurally.

## Library picks (verified; several popular options are traps)

| surface | use | notes |
|---|---|---|
| tree state | **our `PathNode[]`** | No library does DAG unfolding. Every library can render one. |
| virtualization | **TanStack Virtual** | flatten-to-visible-rows is already our shape |
| drag & drop | **pragmatic-drag-and-drop** (Atlassian) | its `Instruction`/`Operation` model *is* our config-object model |
| Miller columns | **build it** | the category is a graveyard, and it's the best DAG view anyway |
| tag input / combobox | **Ark UI / Zag.js** | `@zag-js/vanilla` exists ⇒ one machine backs React *and* vanilla |
| facets | own the refinement state | Algolia's `lvl0/lvl1/lvl2` is the only native multi-parent facet encoding |
| space-filling viz | **d3-hierarchy** as pure math | ⚠️ **no correct treemap of a DAG exists** — project to `PathNode[]` first (icicle: depth→x, index→y) |
| containment graph | **ELK** | ⚠️ EPL-2.0, 423 kB — optional peer dep only |

**Dead / trapped — do not adopt:** `dnd-kit` v6 (16M downloads/wk but **frozen since Dec 2024** — the
download count is a trap), `cmdk` (no release in 16 months), `react-select` (488 open issues),
`react-dnd` (dead since 2022 — and `react-arborist` still pins it), PrimeReact (**archived; v11+ is
paid**), `@mui/base` (deprecated), **MUI X tree DnD (behind a paid Pro licence)**, Orama's disjunctive
facet counts (**broken**), Observable Plot (**has no treemap mark**).

**Every tree library keys UI state by node id** — so a node under two parents expands in both. The
ones that let you *supply* identity (`headless-tree`'s `getChildren(itemId)`, Zag's `nodeToValue`,
TanStack's `getRowId`) become **fully DAG-capable if you feed them our `pathKey`.** That is the
adapter, and it is why `groups-core` owns the unfolding.

## The registry

Register with a `tester` that scores `(surface, profile)`; the highest score wins. Use the `PRIORITY`
bands, not arbitrary numbers.

```ts
registry.register({
  name: 'vanilla:columns',
  tester: (ctx) => ctx.surface !== 'columns' ? 0
    : isSingleHomed(ctx.profile) ? PRIORITY.LIBRARY : PRIORITY.LIBRARY + 10,
  renderer: renderColumns,
});
```

Note it scores on **profile**, not just surface: for `filesystem`, the tree is the right default
(everyone knows the metaphor); for a genuine polyhierarchy, **Miller columns should win.** Express
that judgement as a score, not as a hard-coded component choice.

## Checklist for a new renderer

- [ ] DOM key = `row.key`; expansion keyed by `pathKey`; selection by `nodeId`
- [ ] `row.aria.*` spread onto every row
- [ ] `otherParentCount > 0` → an "also in N" affordance
- [ ] `isRecursive` → rendered as a non-expandable leaf with a marker
- [ ] twins cross-highlighted on hover (use an element **map**, not a CSS selector — a `pathKey` is
      not selector-safe)
- [ ] DnD via `resolveDrop`; ADD default, ⌥ = MOVE, styled differently, reason shown on refusal
- [ ] remove ≠ delete in every menu
- [ ] a registry factory, `create<Lib>Registry()`
- [ ] tests in a real DOM (`environment: 'jsdom'`) asserting the *polyhierarchy* behaviours, not just
      that it rendered — see `packages/groups-ui-vanilla/tests/render.test.ts`

## Routing

- Library landscape with status lines: `docs/research/zgroups_04-*`
- Navigation patterns, DnD semantics, ARIA: `docs/research/zgroups_03-*`
- Decisions: [`docs/research/_reconciliation.md`](../../docs/research/_reconciliation.md) (D12, D13, D15, D16, §5)
