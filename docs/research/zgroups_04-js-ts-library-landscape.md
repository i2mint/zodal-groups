# zodal-groups — JS/TS Library Landscape

**Research date:** July 2026. Every version, publish date, license and download figure below was pulled live from the npm registry API (`registry.npmjs.org`, `api.npmjs.org/downloads`), the GitHub API, and package source on jsDelivr — not from memory [70]. Where I read source to settle a question, I quote it.

---

## 0. The one finding that governs everything

Before the surface-by-surface survey, the single result that decides the architecture:

> **Every tree library in the JavaScript ecosystem keys its UI state by NODE ID. TanStack Table keys its expansion state by ROW ID, and its default row ID for a sub-row is a *materialized path*.**

That difference is the whole ballgame for a DAG.

In a polyhierarchy, a node's **identity** and its **position** are different things. Node `X` reached via `A → X` is a *different occurrence* from the same node reached via `B → X`. The user must be able to expand `X` under `A` while it stays collapsed under `B`. Any library whose `expandedItems` is a `string[]` of node IDs makes that impossible — expanding one occurrence expands all of them.

I verified this in source for both of the serious contenders. It is not a detail; it is the reason we cannot adopt any tree component wholesale, and it is the reason the recommendation below is "own the projection, rent the rendering."

---

## 1. Headless tree / hierarchy state — the critical surface

### 1.1 Candidate status lines

| Library | License | Latest release | Maintenance | Headless? | Framework | Weekly DL | Size |
|---|---|---|---|---|---|---|---|
| **`@headless-tree/core`** | MIT | **1.7.0 — 2026-05-17** | Healthy (870★, 28 open, pushed 2026-05-31) | **Yes — pure state, zero deps** | **Agnostic** (`createTree()` needs no React) | ~222k | **~9.5 kB** core + 0.4 kB React bindings |
| **`@tanstack/table-core`** | MIT | 8.21.3 — **2025-04-14** (v9 in beta: `9.0.0-beta.47`) | Repo very active (28.2k★, pushed 2026-07-13) but **v8 stable is 15 months old**; v9 is where the work is | **Yes** | Agnostic core + React/Vue/Svelte/Solid/Angular adapters | ~17.0M | mid |
| `react-arborist` | MIT | 3.13.2 — 2026-07-05 | Repo active (3.7k★) but **dependency rot — see below** | No (ships markup + row rendering) | React-only | ~695k | large |
| `react-complex-tree` | MIT | 2.6.2 — 2026-06-24 | Maintenance-only. **Author declares headless-tree its official successor** | Partly | React-only | ~273k | — |
| `rc-tree` | MIT | 5.13.1 — **2025-02-25** | Alive but stale-ish (163 open issues); it is AntD's internal engine | No | React-only | ~2.7M | — |
| `@mui/x-tree-view` | MIT (**Pro features commercial**) | 9.9.0 — 2026-07-09 | Very healthy | No | React-only | ~1.09M | large |
| `@zag-js/tree-view` / `@ark-ui/react` | MIT | 1.42.0 — 2026-06-29 / 5.37.2 — 2026-06-08 | Very healthy (Chakra team) | **Yes** (Zag = state machines) | **Agnostic** (React/Vue/Solid/Svelte) | ~929k (Ark) | mid |
| Radix UI | MIT | active | **No tree primitive exists at all** | — | React | — | — |
| Base UI (`@base-ui/react`) | MIT | **1.6.0 — 2026-06-18** | Very healthy; **now shadcn/ui's default primitive layer (July 2026)** | Yes | React | ~6.2M | — |
| PrimeReact `Tree` | MIT | 10.9.8 — 2026-05-14 | Healthy | No | React-only | — | large |
| Ant Design `Tree`/`TreeSelect` | MIT | 6.5.1 — 2026-07-13 | Very healthy | No | React-only | — | very large |

### 1.2 headless-tree — investigated in depth

`headless-tree` is the real thing and it is genuinely framework-agnostic: `@headless-tree/core` exports `createTree()` with **zero dependencies**, and `@headless-tree/react` is a 0.4 kB binding layer [1][2][3]. It shipped 1.0 and is at 1.7.0 (2026-05-17). Feature set is complete for our needs: sync **and async** data loaders with caching, drag-and-drop (including keyboard DnD and foreign drag objects), multi-select, checkboxes, typeahead search, renaming, hotkeys, and explicit virtualization compatibility ("100k+ items") [1].

Its plugin architecture is also strikingly close to our house style — a `FeatureImplementation` registry with `getInitialState` / `getDefaultConfig` / `stateHandlerNames` and feature ordering by `overwrites` — so it composes rather than dictates.

**Ecosystem signal:** neither Radix nor Base UI has a tree primitive [4][5]. The gap in the shadcn ecosystem is being filled by community components (ReUI's `Tree`, shipped in both Radix and Base UI flavours) that are **built on `@headless-tree/core` + `@headless-tree/react`** [6]. If we build a shadcn renderer, headless-tree is the engine our users' other tree components will already be using.

**The DAG verdict — read the source.** `getItemsMeta()` in `features/tree/feature.ts` does a recursive walk that tracks a `path: string[]` and rejects only true cycles:

```ts
const recursiveAdd = (itemId, path, level, setSize, posInSet) => {
  if (path.includes(itemId)) {
    logWarning(`Circular reference for ${path.join(".")}`);
    return;
  }
  flatItems.push({ itemId, level, index: flatItems.length,
                   parentId: path.at(-1), setSize, posInSet });
  ...
};
```

So the **flat list happily emits the same `itemId` twice** under two different parents — a DAG traverses fine and produces two rows. But then `create-tree.ts` collapses them:

```ts
for (const item of treeInstance.getItemsMeta()) {
  itemMetaMap[item.itemId] = item;              // ← last occurrence WINS
  if (!itemInstancesMap[item.itemId]) { ...build... }
  itemInstances.push(itemInstancesMap[item.itemId]);  // ← SAME object pushed twice
}
```

and `getKey: ({ itemId }) => itemId`. The consequences, precisely:

- **State is ID-keyed.** `expandedItems: string[]`, `selectedItems: string[]`, `focusedItem: string | null`. Expand `X` under `A` and it also expands under `B`. `isFocused` is `focusedItem === itemId`, so focus lights up in both places.
- **Per-occurrence metadata is destroyed.** `itemMetaMap` is `Record<itemId, ItemMeta>`, so `level`, `parentId`, `index`, `posInSet` reflect only the *last* occurrence. Both rows render at the same indentation and emit the same `aria-level` / `aria-posinset`.
- **React key collision.** `getKey()` returns the item ID; two rows, one key.
- **`getParent()`** reads `itemMeta.parentId` → a node has exactly one parent, whichever was written last.

So headless-tree is *tree*-shaped **if you feed it domain node IDs**. (A suggestive `// TODO apply to all stories to use` comment sits on `getKey`, hinting the author anticipates key ≠ id someday. Today it is not.)

**But here is the escape hatch, and it is the most useful finding in this report.** headless-tree's data loader is:

```ts
dataLoader: {
  getItem:     (itemId: string) => T,
  getChildren: (itemId: string) => string[],   // ← arbitrary strings. We choose them.
}
```

**Item identity is entirely user-supplied.** So we feed it **synthetic path IDs** — `"root/langs/rust"` rather than `"rust"` — and every one of the four failures above evaporates:

| Failure with node IDs | With path IDs |
|---|---|
| `expandedItems` collides across occurrences | ✅ Path-keyed — independent expansion per occurrence |
| `itemMetaMap` last-occurrence-wins | ✅ One entry per path — correct `level` / `parentId` / `posInSet` |
| `getKey()` React key collision | ✅ Unique per row |
| `getParent()` returns one arbitrary parent | ✅ Returns the parent *on this path* |

`getItem(pathId)` maps back to the domain node. **headless-tree does not need to understand the DAG — it only needs to render the tree we unfold from it.** The library is a perfectly good renderer of a DAG *projection*; it just cannot compute the projection. Which is fine, because that is our job.

**This generalizes into the single test that decides every library in this report:**

> **Can I supply my own node identity, and will the library refrain from de-duplicating behind my back?**

| Library | Identity user-supplied? | DAG-drivable via synthetic path IDs? |
|---|---|---|
| **TanStack Table** | ✅ `getRowId(row, index, parent)` | ✅ **Yes — and it's path-keyed by default anyway** |
| **headless-tree** | ✅ `getChildren(itemId) → string[]` | ✅ **Yes — very elegant** |
| **Zag / Ark TreeView** | ✅ `nodeToValue` / `nodeToString` / `nodeToChildren` | ✅ **Yes — cleanest fit for multi-framework** |
| **Downshift** | ✅ `itemToKey` (v9) | ✅ Yes |
| **Base UI Combobox** | ✅ you own `items` + `filter` | ✅ Yes |
| **AntD TreeSelect** | ✅ `treeData[].value` | ⚠️ Yes, but you translate path↔group at the boundary |
| **cmdk** | ❌ internal scoring keyed on the `value` string; duplicates misrank | ❌ **Fights you** |
| **react-select** | ⚠️ `getOptionValue` — but styled anyway | ❌ Rejected on headless grounds regardless |

### 1.3 TanStack Table — the surprise winner on state identity

We already wrap TanStack Table, so I checked whether it can be the tree engine [65]. The answer hinges on one line in `table-core/src/core/table.ts` [7]:

```ts
_getRowId: (row, index, parent) =>
  table.options.getRowId?.(row, index, parent) ??
  `${parent ? [parent.id, index].join('.') : index}`,
```

**The default row ID for a sub-row is `${parent.id}.${index}` — a materialized path** (`"0.2.1"`). And `ExpandedState` is `true | Record<string, boolean>` **keyed by row ID**. Therefore:

> **TanStack Table's expansion state is PATH-KEYED by default, not node-keyed.** The same domain node materialized at two paths gets two distinct rows with independent expand/select state. It is the *only* mainstream library that gets the DAG state-identity question right — and it gets it right by accident, because it was designed for grouped data where the "same" row can legitimately appear twice.

Better still, `getRowId(originalRow, index, parent)` **receives the parent row**, so we can supply stable, meaningful path IDs instead of index-based ones:

```ts
getRowId: (node, index, parent) => (parent ? `${parent.id}/${node.id}` : node.id)
```

That survives reordering, is human-readable, and *is* the path key our core needs. `row.depth`, `row.parentId`, `row.getParentRow()`, `row.getParentRows()` all exist and all work per-occurrence.

**The limits — and they are real:**

1. **`getCoreRowModel()` builds the entire row tree eagerly.** `accessRows()` recurses through every `getSubRows()` result up front. On a DAG this materializes *every distinct root→node path*. A DAG with heavy path-multiplication (a node with 5 parents each with 5 parents…) explodes combinatorially. This is the central risk of "just use getSubRows for the DAG."
2. **`getSubRows(originalRow, index)` does not receive the parent**, so you cannot make child materialization conditional on the *path's* expanded state from inside it. You cannot lazily prune inside `getSubRows`.
3. No async/lazy loading in the core row model; no DnD; no typeahead; no tree keyboard nav. It is a table, not a tree widget.

### 1.4 Zag.js / Ark UI TreeView — the near miss

Zag's `TreeCollection` (`@zag-js/collection`) is a genuinely nice framework-agnostic tree data structure with `at(indexPath)`, `getIndexPath(value)`, `getValuePath(indexPath)`, `getParentNodes()`, `getDescendantValues()`, `visit()`, plus immutable `insertBefore` / `move` / `remove` / `filter` [8]. The node props require an `indexPath`, and it exposes both `IndexPath` and `ValuePath` types — path-awareness is *in the API*.

But the machine's state is still `expandedValue: string[]`, `selectedValue: string[]`, `checkedValue: string[]` — **keyed by value (node ID)** [9]. And `findNode(value)` / `getIndexPath(value)` return the *first* match, i.e. the collection assumes value uniqueness. Same ID-keying as headless-tree — **and the same escape hatch**: the collection takes **`nodeToValue`**, so we return path strings and the state becomes path-keyed.

**And Zag has a decisive structural advantage.** `@zag-js/vanilla` now exists (v1.42.0, MIT, first published 2026-01-02) [51]. Zag officially ships **React, Vue, Solid, Svelte, Preact *and* vanilla** adapters, released in lockstep from **one state machine**. That is the only abstraction in this entire survey that can back our **shadcn/React renderer *and* our vanilla-JS renderer from a single headless core**. (Caveat, honestly: the vanilla adapter is new and unproven — ~1.6k weekly downloads.)

Zag also shipped **`@zag-js/cascade-select`** (first published 2026-02-19, ~610k/wk) [52] — **the only headless, framework-agnostic cascader in existence.** It is marked **Beta** in the docs. Ark UI declares it as a dependency but has **not yet shipped a `CascadeSelect` wrapper** (no component directory on `main`) — so bind to the Zag machine directly if you want it.

### 1.5 The rest, briefly and honestly

- **react-arborist** — repo pushed 2026-07-05, so it *looks* alive, but its dependency tree is rotting: it pins **`react-dnd@^14`** (react-dnd itself is dead — last release 16.0.1, **April 2022**) and **`react-window@^1.8`** (v2 shipped Feb 2026), plus `redux`. It is React-only, renders its own rows, and bakes in its own virtualization. Not headless, not agnostic, and it drags a dead DnD library into our bundle. **Do not adopt.**
- **react-complex-tree** — the author has publicly designated headless-tree its successor. Still patched (2.6.2, 2026-06-24) but it is a legacy path. **Don't start here.**
- **`@mui/x-tree-view`** — good component, but **drag-and-drop reordering (`itemsReordering` on `RichTreeViewPro`) is behind MUI X's commercial Pro licence** [10]. That's a licensing landmine for a library we ship, and it's React-only and styled. **Flag: violates headless-first and adds a paid dependency for a core feature.**
- **rc-tree / AntD Tree / PrimeReact Tree** — all styled, React-only, ID-keyed, and they drag in an entire design system. Fine as *renderer* targets, disqualified as an engine.
- **Radix** — has no tree primitive whatsoever. **Base UI** (now shadcn's default, 1.6.0, MIT) has 50 components and no tree either [4][5]. Worth internalizing: the two most influential primitive libraries in React have both declined to build a tree.

### 1.6 Recommendation — surface 1

**PRIMARY: build the DAG→visible-rows projection in `@zodal/groups-core` ourselves (path-keyed), and rent the rendering.**

This is not "reinventing the wheel" — it is exactly the wheel nobody has built, and the survey above is the proof. Concretely, core owns a pure function:

```ts
// pure data in, pure data out — no DOM, no framework
type RowKey = string;                       // materialized path: "root/a/x"
type VisibleRow = {
  key: RowKey;                              // ← state identity
  nodeId: NodeId;                           // ← domain identity (may repeat)
  path: NodeId[];
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  parentCount: number;                      // > 1 ⇒ this node is polyhierarchical
};
flattenVisible(dag, expanded: Set<RowKey>): VisibleRow[]
```

Expansion/selection state is a `Set<RowKey>` (path-keyed) — with an *optional* `keyBy: 'path' | 'node'` strategy, because "expand this node everywhere it appears" is a legitimate alternative UX and should be a config choice, not an accident of the library. That `keyBy` toggle is the honest answer to the brief's question, and it is only expressible because *we* own the state.

`flattenVisible` cuts the eager-materialization problem dead: it only ever walks *expanded* paths, so cost is O(visible rows), never O(all paths). It also naturally handles the DAG's danger case — a cycle guard on `path` (which is what headless-tree already does).

Two non-negotiable design constraints fall out of the survey:

1. **Unfold LAZILY.** A DAG's path expansion is exponential in the worst case (a diamond lattice explodes). `flattenVisible` must only walk *expanded* paths, memoize per path, and carry a **cycle guard + depth cap**. Never eagerly materialize the unfolding. This is precisely why we cannot use TanStack's `getSubRows` (§1.3, limit 1).
2. **Ordering/weight belongs on the (parent, child) EDGE, not on the node.** Drupal supports multi-parent taxonomy terms but gives a term a single `weight` — with the result that **you cannot drag-and-drop a term that has multiple parents** [50]. A mature system learned this the hard way; bake it in from day one.

**Then rent — and every library below is drivable, because we hand it path IDs:**
- **`@tanstack/table-core` / `@tanstack/react-table`** (MIT, agnostic core) for row/column rendering — feed it the flat `VisibleRow[]` with `getRowId: r => r.key`. **Do not use `getSubRows`** for the DAG (eager materialization). Flatten ourselves, hand it a flat list. We already wrap it; consistency is free.
- **`@headless-tree/core`** (MIT, agnostic, 9.5 kB) for the tree widget itself — `getChildren(pathId)` returns child path IDs, `getItem(pathId)` maps back to the group. We get keyboard nav, typeahead, renaming, hotkeys, checkboxes, async loading and DnD glue for free, **fully path-keyed**. It is also what the shadcn ecosystem's tree components already run on [6], so our shadcn satellite is idiomatic by default.

**FALLBACK — and arguably the strategic pick: Zag.js.** `@zag-js/tree-view` + `@zag-js/collection` with `nodeToValue` returning path IDs. It is the **only** abstraction that can back the shadcn/React satellite **and** the vanilla satellite **and** future Vue/Svelte/Solid satellites from **one machine** (`@zag-js/vanilla` shipped 2026-01-02). If we expect more than two renderers, bet on Zag; if we expect exactly React + vanilla and want the richest tree feature set today, headless-tree is the safer, more complete choice.

**Flags:** `@mui/x-tree-view` (**DnD reordering is behind MUI X's commercial Pro licence** — a paid dependency for a core feature). `react-arborist` (React-only, not headless, and pins the **dead** `react-dnd@^14`). **PrimeReact is archived on GitHub and v11+ moves to a paid commercial licence** ($599/dev) — existing MIT versions stay MIT, but **do not build on it**. AntD/rc-* (styled, React-only — renderer targets at most).

---

## 2. Virtualization for trees

The flatten-visible-rows pattern is the *only* way to virtualize a tree, and it falls out of §1.6 for free: once `flattenVisible()` returns a flat `VisibleRow[]`, virtualization is an ordinary list problem.

| Library | License | Latest | Maintenance | Headless? | Framework | Weekly DL |
|---|---|---|---|---|---|---|
| **`@tanstack/virtual-core`** | MIT | **3.17.4 — 2026-07-12** | Very healthy (7.0k★, pushed 2026-07-12) | **Yes — ships no markup or styles** | **Agnostic**: JS/TS, React, Vue, Svelte, Solid, Lit, Angular | **~16.8M** |
| `react-window` | MIT | 2.2.7 — 2026-02-13 | Healthy (v2 rewrite shipped) | No (renders rows) | React-only | ~6.3M |
| `react-virtuoso` | MIT | 4.18.10 — 2026-06-27 | Healthy | No | React-only | ~2.9M |
| `virtua` | MIT | 0.49.3 — 2026-07-11 | Healthy, ~3 kB | Partly | React/Vue/Svelte/Solid | ~624k |

### Recommendation — surface 2

**PRIMARY: `@tanstack/virtual-core` (+ `@tanstack/react-virtual` in the React satellite)** [64]**.** It is the only candidate that is *both* headless and framework-agnostic — the same virtualizer core drives the shadcn satellite *and* the vanilla-JS satellite. It renders nothing, which is exactly our contract. It also composes with TanStack Table, which we already wrap, and headless-tree explicitly documents virtualization compatibility.

**FALLBACK: `virtua`** (tiny, multi-framework). **`react-window` / `react-virtuoso`** are React-only and render their own rows — usable inside the shadcn satellite, unusable in the vanilla one. Don't put either in core.

**DAG note:** virtualization is DAG-neutral *provided* the row key is the path. With ID-keyed rows you get duplicate React keys in the virtualized window — another way the path-keyed decision pays for itself.

---

## 3. Drag and drop

### 3.1 Status lines

| Library | License | Latest release | Maintenance | Headless? | Framework | Weekly DL | Size (gzip) |
|---|---|---|---|---|---|---|---|
| **`@atlaskit/pragmatic-drag-and-drop`** | **Apache-2.0** | **2.0.1 — 2026-06-17** | **Healthy** (12.7k★, pushed 2026-07-10; powers Jira/Trello/Confluence) | **Yes — emits data, never DOM** | **Agnostic** (React/Vue/Svelte/Angular/vanilla) | ~1.08M | ~4.7 kB core+adapter |
| `@atlaskit/pragmatic-drag-and-drop-hitbox` | Apache-2.0 | 2.0.0 — 2026-06-16 | Healthy | Yes (pure geometry → data) | Agnostic | ~772k | per entry point |
| `@dnd-kit/core` (**legacy v6**) | MIT | **6.3.1 — 2024-12-05** | **FROZEN.** `master` last commit 2024-12-05; the docs repo was **archived 2026-02-21** | Partly | React | ~16.4M ⚠️ | 13.9 kB |
| `@dnd-kit/dom` (**"next"**) | MIT | 0.5.0 — 2026-06-11 | Active but **pre-1.0, self-declared unstable API** | Yes-ish | Agnostic | ~785k | **29 kB** |
| `react-dnd` | MIT | **16.0.1 — 2022-04-19** | **DEAD.** 4+ years, 474 open issues | No | React | ~4.2M | 8.7 kB |
| `sortablejs` | MIT | 1.15.7 — 2026-02-11 | Alive, 523 open issues | **No — mutates the DOM itself** | Agnostic | ~4.0M | 17.9 kB |
| `@formkit/drag-and-drop` | MIT | 0.6.1 — 2026-06-15 | Active | Data-first | Agnostic | ~104k | 12.3 kB |
| `swapy` | **GPL-3.0** ⛔ | 1.0.5 — 2025-01-19 | Stagnant 18 mo | No | Agnostic | ~16k | — |

**The dnd-kit download figure is a trap** [67]**.** Its 16.4M weekly downloads are for the **frozen v6 line**. The actively-developed line (`@dnd-kit/dom`) does ~785k — *fewer than pragmatic-drag-and-drop's 1.08M*. `next.dndkit.com` now redirects to `dndkit.com` and v6 has been relegated to `/legacy/`. Anyone citing dnd-kit's popularity is citing a version its author has stopped developing. There is **no official tree recipe** — only a Storybook story (`stories/3 - Examples/Tree/SortableTree.tsx`), and the popular community wrapper `dnd-kit-sortable-tree` is **dead** (0.1.73, July 2023, built against frozen v6).

### 3.2 Pragmatic drag-and-drop ships *exactly* our config-object model

Its hitbox package [68] exports, verbatim, the "instruction" concept [11]:

```ts
export type Instruction =
  | { type: 'reorder-above'; currentLevel: number; indentPerLevel: number }
  | { type: 'reorder-below'; currentLevel: number; indentPerLevel: number }
  | { type: 'make-child';    currentLevel: number; indentPerLevel: number }
  | { type: 'reparent';      currentLevel: number; indentPerLevel: number; desiredLevel: number }
  | { type: 'instruction-blocked'; desired: Exclude<Instruction, {type:'instruction-blocked'}> };
```

Three properties make it the right dependency:

1. **Geometry in, plain data out.** `attachInstruction(userData, {...})` puts an `Instruction` on the drop target's data; `extractInstruction(data)` reads it in `onDrop`. It never touches your DOM, never owns your tree, never reorders anything. That *is* the zodal contract.
2. **`instruction-blocked` is a rendered affordance, not a silent no-op.** The `block?: Instruction['type'][]` option converts a *desired* instruction into `{type:'instruction-blocked', desired}` — so the UI can say "you can't drop here, and here's what you were trying to do." A group's permitted operations gate the hitbox, and rejection is *rendered*. That maps straight onto our affordance model.
3. **A newer, more general hitbox** (`list-item.ts`) supersedes the tree-specific one and suits us better [12]:
   ```ts
   export type Operation = 'reorder-before' | 'reorder-after' | 'combine';
   export type Availability = 'available' | 'not-available' | 'blocked';
   ```
   `attachInstruction` takes an `operations: {[K in Operation]?: Availability}` map plus `axis: 'horizontal' | 'vertical'`. The hitbox **re-partitions itself** based on which operations are available (50/50 split when `combine` is unavailable; 25/50/25 when it is). That availability map is a direct serialization of a zodal affordance set — and the `horizontal` axis means **the same hitbox drives Miller columns**, not just indented trees.

### 3.3 "Drop = add-a-parent" vs "drop = move" — the DAG question

**No DnD library implements "drop = add a parent."** All of them assume drop = move. But this is the wrong question to ask a DnD library, and pdnd is the only candidate for which it doesn't matter:

- **pdnd has no opinion about what a drop *means*.** It reports "the user gestured `make-child` on node X" and stops. Whether `onDrop` responds by *moving* an edge or *adding* one is entirely our code. dnd-kit's `sortable` preset, by contrast, wants to own an array and reorder it — we'd be fighting it.
- **Modifier keys are already in the payload.** pdnd's `Input` type carries `altKey` / `ctrlKey` / `metaKey` / `shiftKey` alongside the coordinates, and `Input` is passed to *both* `getData({input})` (hitbox time) and `onDrop({location})` (commit time) [13]. So the canonical desktop idiom — **plain drop = move (reparent), Alt/Option+drop = add an *additional* parent (link)** — needs zero library modification, *and* the allowed `operations` map can be swapped mid-drag on the modifier so the drop indicator changes shape the instant the user holds Alt. That is precisely the interaction vocabulary a polyhierarchy needs.

Everything else fails structurally: **SortableJS mutates the DOM itself** (fatal — it would fight React's reconciler and can't be driven from a headless config); **`@formkit/drag-and-drop`** is flat-list only, no nesting, no hitbox; **`swapy` is GPL-3.0**, a licensing non-starter for a permissively-licensed library; **`react-dnd` is dead**; **native HTML5 DnD** is the pit of despair pdnd exists to paper over (drag previews, Safari quirks, `dragenter`/`dragleave` counting).

### 3.4 Recommendation — surface 3

**PRIMARY: `@atlaskit/pragmatic-drag-and-drop` + `-hitbox` + `-auto-scroll`** (and `-react-drop-indicator` **in the shadcn satellite only** — it's React-only). Apache-2.0, actively shipped, framework-agnostic, ~5–6× smaller than `@dnd-kit/dom`, and its `Instruction` / `Operation` data model is the one we'd have designed ourselves.

**Keep core clean:** `@zodal/groups-core` should define its *own* `DropIntent` union — `reorder-before | reorder-after | add-child | move-child | add-parent | reparent` — and ship a tiny mapper from pdnd's `Instruction`. pdnd then lives in the *satellites*, not in core, so core stays DOM-free and a future renderer could substitute dnd-kit without touching it.

**FALLBACK: dnd-kit "next" (`@dnd-kit/dom`).** Genuinely agnostic and actively developed, but pre-1.0 with a self-declared unstable API, 29 kB, and no official tree recipe. Reach for it only if Apache-2.0 or Atlassian's mirror-only contribution model (external PRs not accepted) becomes a blocker.

**Flags:** `swapy` (GPL-3.0 — disqualified). `sortablejs` (DOM-mutating — violates headless-first). `react-dnd` (dead; and it's what `react-arborist` depends on).

---

## 4. Miller columns / column view

### 4.1 The entire landscape — and it is a graveyard

I enumerated the npm registry for "miller columns". This is *all of it*:

| Package | License | Latest | Signal | Weekly DL |
|---|---|---|---|---|
| `miller-columns-element` (**alphagov**, not GitHub/Primer) [66] | MIT | 2.0.1 — 2025-03-04 | **ARCHIVED 2025-08-28**; hard-coupled to `govuk-frontend` CSS | **170** |
| `miller-columns` (brettz9) | MIT | 0.17.0 — 2025-12-14 | Solo hobby repo, **7★** | **53** |
| `react-miller-columns` | ISC | **1.0.0 — 2019-08-13** | **Dead.** One version, ever | **15** |
| `@mints/miller-columns` | MIT | 2.0.0-**beta**.11 — 2024-09-29 | Perpetual beta; MUI-coupled | — |
| `miller-columns-select` | MIT | 1.4.1 — 2024-04-07 | Stagnant | — |
| `finderjs`, `angular-miller-columns`, `jquery-miller-columns`, `column-view-component` | — | 2016–2019 | **All dead** | — |

The best-maintained entry in the entire category is a **7-star personal repo doing 53 downloads a week**. Radix, Base UI, Ark, Chakra and shadcn ship nothing here.

### 4.2 Recommendation — surface 4: **BUILD IT, and be glad**

This is not a reluctant "nothing exists, so we must." **Miller columns are the single best view for a DAG**, for exactly the reason §0 identified:

> A Miller column view is **path-oriented, not node-oriented**. Column *i+1* is just `children(selection[i])`. The user's current path from root **is** the view state.

An indented tree showing a DAG must *duplicate subtrees* — a node with three parents appears three times, and expansion state becomes ambiguous (the bug every tree library has). A Miller column view has no such problem: it displays **one path at a time**, and that path is explicit. Multi-parentness degrades gracefully into a rendering detail (a badge; an "also in 2 other groups" affordance) rather than a structural crisis.

Core emits a `reduce` over the path:

```ts
type ColumnsConfig = {
  path: NodeId[];                                    // the SSOT
  columns: Array<{ groupId: NodeId; items: NodeRef[]; selectedId: NodeId | null }>;
};
```

The real work is keyboard nav (←/→ across columns, ↑/↓ within) and virtualizing tall columns — neither of which any of the nine dead packages provides. **Take zero dependencies here.** pdnd's `list-item` hitbox with `axis: 'horizontal'` gives us cross-column drag for free.

---

## 5. Breadcrumbs

| Library | Breadcrumb? | Notes |
|---|---|---|
| **Radix UI** | **No — no breadcrumb primitive exists** | Verified against the full `packages/react/` list |
| **shadcn/ui** | Yes — hand-rolled semantic `<nav>/<ol>` (uses Radix `Slot` only for `asChild`) | `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbPage`, `BreadcrumbSeparator`, `BreadcrumbEllipsis` |
| **Ark UI** | No | — |
| **Chakra v3** | Yes | Styled, single-path |

### Multi-path: absent everywhere — and *deliberately* so

**No library handles multi-path breadcrumbs.** More interestingly, this isn't an oversight: it's a design-community consensus *against* it. NN/g's breadcrumb guidance and the ui-patterns canon both hold that in polyhierarchical IA, showing multiple pathways *"risks cluttering the top of the page and confusing users"* — the received wisdom is **show one primary path, hide the rest** [14][15]. (IBM WebSphere Commerce even shipped a bug, APAR JR54092, amounting to "breadcrumb picks the wrong parent when a category has several" [16].)

So we are deliberately building something the design establishment discourages. That is defensible for a *polyhierarchy tool*, where multi-parentness is the point rather than an accident — but it means we own the interaction design, and the honest default should be **one primary path with the alternates one click away**, not all paths at once.

### Recommendation — surface 5: thin layer, zero new dependencies

Happy accident: **shadcn's `BreadcrumbEllipsis` + `DropdownMenu` composition is structurally the exact widget a path-chooser needs** [69]**.** shadcn documents it for *truncating a long path*; we repurpose the identical markup and a11y to mean *"this crumb's node has 3 parents — pick which ancestry you're viewing."* Core emits:

```ts
type BreadcrumbConfig = {
  activePath: NodeId[];
  crumbs: Array<{ node: NodeRef; alternateParents: NodeRef[] }>;  // length > 1 ⇒ render a dropdown
};
```

Renderers map `alternateParents.length > 1` to a dropdown; the vanilla satellite gets a `<details>` or listbox. The shadcn satellite already has `DropdownMenu`. **No new dependency.**

---

## 6. Tag input / token input / combobox multi-select

| Library | License | Latest release | Maintenance | Headless? | Framework | Weekly DL | Size (gz) |
|---|---|---|---|---|---|---|---|
| **`@zag-js/combobox` + `@zag-js/tags-input`** | MIT | **1.42.0 — 2026-06-29** | **Very active** (Chakra team; monthly) | **Yes — pure state machine** | **React, Vue, Solid, Svelte, Preact, Vanilla** | ~898k / ~871k | **25.7 kB** (core alone 2.2 kB) |
| **`@base-ui/react`** Combobox | MIT | **1.6.0 — 2026-06-18** | **Very active**; 1.0 shipped 2025-12-11, monthly cadence | **Yes** (unstyled) | **React only** | **~6.2M** | tree-shakes per component |
| `@ark-ui/react` (Combobox + TagsInput) | MIT | 5.37.2 — 2026-06-08 | Very active | **Yes** (unstyled components over Zag) | React, Vue, Solid, Svelte (**no vanilla**) | ~929k | tree-shakes |
| **Downshift** | MIT | 9.4.0 — 2026-06-30 | **Active** | **Yes — hooks only** | **React only** | ~3.83M | 14.8 kB |
| **cmdk** | MIT | **1.1.1 — 2025-03-14 (16 months ago)** | ⚠️ **Stagnant.** 73 open issues; **repo transferred away from the original author** | Partly — unstyled, but it **renders DOM** | React only | **~36.4M** (shadcn pulls it) | 14.6 kB (4 Radix deps) |
| **react-select** | MIT | 5.10.2 — **2025-07-11** | ⚠️ **Stagnant/coasting.** **488 open issues**; *"Is this package still maintained?"* (#5907) open since 2024 [56] | **No — styled** (bundles Emotion) | React only | ~8.75M | 29.1 kB |
| `@mui/material` `useAutocomplete` | MIT | active | Active | Hook is headless, but drags in `@mui/material` | React only | ~7.8M | heavy |
| `@mui/base` | MIT | 5.0.0-beta.70 — 2025-03-17 | ☠️ **DEPRECATED** — *"replaced by @base-ui/react"* [57]. Never left beta in ~4 years | — | — | ~3.9M (inertia) | — |
| `emblor` | MIT | 1.4.8 — 2025-03-28 | Stagnant | No — styled | React only | ~37k | 16.9 kB |
| `react-tag-input` | MIT | 6.10.6 — 2025-02-18 | Stagnant; 109 open issues; needs the **dead** `react-dnd` peer | No — styled | React only | ~53k | 9.8 kB |
| `react-tagsinput` | MIT | **3.20.3 — 2023-06-10** | ☠️ **DEAD** (3 years) | No | React (peer caps at 18) | ~140k | — |

### Hierarchical tag suggestion — what actually breaks

**None of them do hierarchy.** Precisely:

- **react-select** — `options` accepts `GroupBase<Option>[]`: **exactly one level** of grouping, no nesting. Showing `parent/child` paths means flattening yourself and faking indentation via `formatOptionLabel`. And it's **styled** (Emotion is a hard dep) → **violates headless-first**.
- **Downshift** — flat `items`; `getItemProps({index})` is a **linear index**. Grouping = flatten to a linear list, render headers outside the index space, hand-manage keyboard nav to skip them. Tractable but manual. Implements the ARIA 1.2 combobox pattern. React-only.
- **cmdk** — `Command.Group` is one flat level, and cmdk does its **own internal scoring keyed on a `value` string**, so **duplicate values collapse/misrank**. It *renders DOM* — it is "unstyled", not "headless". Combined with 16 months without a release and a repo handover [55], **do not build a core on it.**
- **Base UI Combobox** — `Combobox.Group` + `GroupLabel` (one level), plus a `filter` prop. **`multiple` + `Combobox.Chips` / `Chip` / `ChipRemove` gives the tag-chip UX natively** [53]. Because you supply items and the filter, rendering `Parent / Child` path labels and filtering on the full path string works fine.
- **Ark UI / Zag Combobox** — `ItemGroup` + `ItemGroupLabel` (one level); `multiple` renders selections as tags; Ark documents **Combobox + TagsInput composition** as an official pattern. Identity is yours via `nodeToValue` / `nodeToString`.

### The chip-ancestry problem (a genuine product decision, not an implementation detail)

**A chip for a two-parent group has no single ancestry to display.** Rendering `Systems / Rust` is a *lie by omission*. Decide deliberately: either show the path the user actually navigated (store it as **UI-only provenance, never as identity**), or show `Rust ·2 paths` with the ancestries in a tooltip. **This is the one place where the DAG leaks into the UX no matter how clean the core is.**

### Recommendation — surface 6

**PRIMARY: `@zag-js/combobox` + `@zag-js/tags-input`** [62]**.** The only candidate satisfying the hard constraint — **one headless abstraction → shadcn/React renderer AND vanilla renderer** (`@zag-js/react` + `@zag-js/vanilla`). MIT, monthly releases, WAI-ARIA compliant, 2.2 kB core, and identity is user-controlled via `nodeToValue` — which is exactly what makes path-ID DAG unfolding work. **Depend on Zag machines, not Ark**; Ark is an optional styled-component convenience layer on top.

**FALLBACK (React satellite only): `@base-ui/react` Combobox.** Now 1.0-stable, MIT, 6.2M/wk, native `multiple` + Chips + Groups + custom `filter` — **and shadcn ships it as `base/combobox`** [54], so the shadcn satellite gets it with zero glue. This removes **cmdk from our critical path entirely**, which is a real win given cmdk's stagnation. Weakness: React-only, so it can never back the vanilla renderer.

**REJECT:** react-select (styled + Emotion + 488 open issues + stagnant), cmdk (stagnant, DOM-rendering, repo handover), emblor / react-tag-input (stagnant, styled), react-tagsinput (**dead since 2023**), `@mui/base` (**deprecated**).

---

## 7. Tree select / cascader

| Library | License | Latest release | Maintenance | Headless? | Framework | Weekly DL | Size (gz) |
|---|---|---|---|---|---|---|---|
| **`@zag-js/cascade-select`** | MIT | 1.42.0 — 2026-06-29 (**first published 2026-02-19**) | Active, but **marked BETA** in the docs | **YES — the only headless cascader that exists** | React, Vue, Solid, Svelte, Preact, **Vanilla** | ~610k | part of Zag |
| **`@zag-js/tree-view`** / Ark `TreeView` | MIT | 1.42.0 — 2026-06-29 | **Active** (since Jan 2024) | **Yes** | Same 6 adapters | **~1.02M** | — |
| **`@headless-tree/core`** | MIT | 1.7.0 — 2026-05-17 | Active (solo maintainer, 870★) | **Yes — genuinely headless, zero deps** | Core is framework-free; **only React bindings ship today** | 222k / 197k | **12.3 kB** |
| **`@rc-component/tree-select`** | MIT | **1.15.0 — 2026-07-10** | **Active** — *this is the live line* | No — renders DOM, ships CSS | React | ~756k | — |
| **`@rc-component/cascader`** | MIT | **1.21.0 — 2026-07-10** | **Active** — *the live line* | No | React | ~782k | — |
| ~~`rc-tree-select`~~ / ~~`rc-cascader`~~ | MIT | 5.27.0 — 2025-01-07 / 3.34.0 — 2025-04-01 | ⚠️ **FROZEN** — superseded by the `@rc-component/*` scope (Feb 2025) | No | React | 2.48M / 1.99M (**inertia**) | — |
| Ant Design `TreeSelect` / `Cascader` | MIT | 6.5.1 — 2026-07-13 | Very active (98.7k★) | **No — fully styled** | React | ~3.65M | huge |
| `@mui/x-tree-view` | MIT (Community tier) | 9.9.0 — 2026-07-09 | Very active | No — MUI-styled | React | ~1.09M | — |
| Kobalte (`@kobalte/core`) | MIT | 0.13.12 — 2026-06-30 | Alive but slow | Yes | **Solid only** | ~234k | — |
| Melt UI (`melt`, next-gen) | MIT | 0.44.0 — 2026-01-04 | ⚠️ **Slowing** | Yes | **Svelte 5 only** | ~6k | — |
| PrimeReact `TreeSelect`/`CascadeSelect` | MIT **≤10.x only** | 10.9.8 — 2026-05-14 | ☠️ **GitHub repo ARCHIVED. v11+ is a PAID commercial licence** [58][59] | No | React | ~362k | — |
| `react-dropdown-tree-select` | MIT | **2.8.0 — 2023-01-15** | ☠️ **DEAD** (3.5 years) | No | React (peer caps at 18) | ~49k | 14.7 kB |
| `treeselectjs` | MIT | 0.14.2 — 2026-03-10 | Alive but tiny (110★, solo) | **No — ships CSS, renders DOM** | **Vanilla** (+ React/Vue wrappers) | **~2k** | 8.9 kB, 0 deps |

### Is there anything headless? Exactly one thing.

**`@zag-js/cascade-select` is the only headless, framework-agnostic cascader in existence.** Verified live in the Zag monorepo (`packages/machines/cascade-select`), MIT, with active bug-fix commits (e.g. *"Fix issue where pressing Enter on a highlighted leaf node did not select it in non-React frameworks"*). Docs mark it **Beta** — treat it as *young*, not stable. **Ark UI does not expose it yet**: `@ark-ui/react@5.37.2` declares `@zag-js/cascade-select` in `package.json` but there is **no `CascadeSelect` component directory** on `main`. It is staged, not shipped. Bind to the machine directly.

**headless-tree** is genuinely headless and dependency-free, but has **no combobox/select/dropdown integration whatsoever** — it's a *tree*, not a *tree select*. You compose it inside a popover yourself.

**Kobalte** (Solid-only) and **Melt UI** (Svelte-only) have headless comboboxes and trees but **no tree-select**, and each is locked to one framework — useless as a shared core.

**AntD / rc-\* / MUI X / PrimeReact** are all **styled component libraries** that render DOM and ship CSS. They fail headless-first for the core; they are renderer-satellite material at most.

> **Ecosystem trap worth knowing:** the react-component org **re-scoped in Feb 2025** [60]. `rc-tree-select` / `rc-cascader` still show 2.5M / 2.0M weekly downloads but are **frozen**. The live packages are **`@rc-component/tree-select` (1.15.0)** and **`@rc-component/cascader` (1.21.0)**, both released 2026-07-10, and both are what `antd@6` actually depends on. Reference the new scope.

### DAG / multi-parent: cascaders break in a *different* way

**Cascaders are strictly path-based by design.** AntD Cascader's `value` is `string[]` (a root→leaf path); Zag's cascade-select in `multiple` mode holds an **array of path arrays**: `[["north-america","us","ny"], ["africa","ng"]]`.

That sounds DAG-friendly, and it half is. But a DAG node with two parents has **two different, equally valid `value`s**, and:

1. **Equality/dedup collapses.** In `multiple` mode the widget will happily hold `["Languages","Rust"]` *and* `["Systems","Rust"]` as **two separate selections of the same group**. It has no idea they're one thing. Selection counts, "already selected" checks, and remove-chip logic all break unless **we** normalize path → groupId.
2. **Round-tripping is lossy.** Given a stored `groupId`, *which* path do you display? There are N. The cascader API gives you no way to say "this group, reached however."
3. **Search and lazy-load are mutually exclusive in AntD** (*"loadData cannot work with showSearch"*) — and a DAG basically forces lazy unfolding.

Meanwhile the **tree-select** family breaks the *other* way: **AntD TreeSelect's docs say outright "ensure the uniqueness of each value"** [61]; `treeselectjs` says *"do not use duplicated `value` field."* Feed either a DAG with real node IDs and selecting one occurrence selects them all. **Feed them path IDs and both are fine** — which is the §1.2 test again.

### Recommendation — surface 7

**PRIMARY: `@zag-js/tree-view` + `@zag-js/combobox`, composed into our own group-picker**, with `nodeToValue` returning path IDs. `tree-view` is mature (~1.02M/wk, shipping since Jan 2024), MIT, actively maintained, multi-framework including vanilla. A tree-view inside a popover with a combobox filter *is* a tree-select, and we avoid putting a Beta machine on the critical path.

**Expose `@zag-js/cascade-select` as an opt-in second presentation** once it leaves Beta — it is a genuinely exciting fit (the only headless cascader in the world) but it is ~5 months old.

**FALLBACK: `headless-tree` for the React satellite** — zero deps, 12.3 kB, truly headless, and `getChildren(itemId)` is *ideal* for path-ID unfolding. Limits: React-only in practice, solo maintainer, no select/combobox integration (you compose the popover).

**RENDERER-SATELLITE ONLY (never core):** AntD `TreeSelect` / `Cascader` — best-in-class **reference implementations to copy the UX from**, MIT, actively released.

**REJECT:** **PrimeReact** (archived; v11+ is paid, non-OSS), **react-dropdown-tree-select** (dead since Jan 2023), legacy `rc-*` (frozen — use `@rc-component/*`), `@melt-ui/svelte` v1 (frozen). **`treeselectjs`** is alive but 2k downloads, solo, ships CSS and renders DOM — **not headless**; worth reading as a *reference* for the vanilla renderer, not depending on.

---

## 8. Faceted search UI with hierarchical facets

### 8.1 The InstantSearch stack decomposes into four layers — and only the top one is Algolia-locked

```
algoliasearch (HTTP client)   ← Algolia-locked, but REPLACEABLE via a custom searchClient
   ↑
algoliasearch-helper          ← HEADLESS. State machine + hierarchical facet TREE BUILDER. Pure JS, zero DOM.
   ↑
instantsearch.js/connectors   ← HEADLESS. connectHierarchicalMenu → {items, refine, createURL}
   ↑
react-instantsearch widgets   ← DOM / React rendering
```

| Package | License | Latest | Maintenance | Headless? | Framework | Weekly DL | Size |
|---|---|---|---|---|---|---|---|
| **`algoliasearch-helper`** | MIT | **3.29.2 — 2026-07-07** | Active (now inside the `algolia/instantsearch` monorepo) | **Yes — fully** | Agnostic, zero DOM | ~1.92M | ~11 kB |
| **`instantsearch.js`** (connectors) | MIT | 4.105.0 — 2026-07-07 | Active (weekly releases; 4.1k★) | **Yes** (`instantsearch.js/es/connectors`) | Agnostic (vanilla) | ~500k | connectors slim |
| `react-instantsearch-core` | MIT | 7.39.0 — 2026-07-07 | Active | **Yes** — hooks only | React | ~443k | small |
| `react-instantsearch` | MIT | 7.39.0 — 2026-07-07 | Active | No (styled widgets) | React | ~416k | — |

**The connectors are genuinely headless** — Algolia's own words: *"Hooks are the headless counterparts of widgets."* `useHierarchicalMenu` / `connectHierarchicalMenu` return `{items, refine, createURL}` and render nothing [17][18].

### 8.2 The `lvl0/lvl1/lvl2` data contract, precisely

Each level attribute stores the **full path from the root**, not just the leaf label:

```json
{ "objectID": "321432", "name": "lemon",
  "categories": { "lvl0": "products", "lvl1": "products > fruits" } }
```

```js
hierarchicalMenu({
  attributes: ['categories.lvl0', 'categories.lvl1', 'categories.lvl2'],  // array order = level order
  separator: ' > ',        // default; must match what's baked into the strings
  rootPath: null,          // e.g. 'products > fruits' to start mid-tree
  showParentLevel: true,
  limit: 10, sortBy: ['name:asc'], transformItems: (i) => i,
})
```

Every level must be **declared individually as a facet** in the index settings — Algolia does not infer them [19].

The returned item shape — identical from `useHierarchicalMenu`, `connectHierarchicalMenu`, and `SearchResults#getFacetValues` — is:

```ts
interface HierarchicalMenuItem {
  value: string;                        // the FULL path, e.g. "products > fruits"
  label: string;                        // leaf label, e.g. "fruits"
  count: number;                        // docs matching THIS path
  isRefined: boolean;
  data: HierarchicalMenuItem[] | null;  // next level, populated below the refinement
}
```

**That nested `{label, value, count, isRefined, data[]}` node is exactly the plain config object a headless core should emit.** It is the best-tested hierarchical-facet contract in the ecosystem, and `algoliasearch-helper` builds it **client-side from flat facet counts**. Adopt the shape.

### 8.3 DAG / multi-parent: **YES — and it's the only stack that supports it natively**

Algolia's faceting guide explicitly documents **arrays of paths** per level [19]:

```json
{ "categories": {
    "lvl0": "Books",
    "lvl1": ["Books > Science Fiction", "Books > Literature and Fiction"],
    "lvl2": ["Books > Science Fiction > Time Travel",
             "Books > Literature and Fiction > Modernism"] } }
```

One item, **two distinct root→leaf paths**. A genuine multi-parent encoding — and it is *semantically correct here*, because a facet count means *"documents matching this path"*, not *"sum of child values"*. A document under two sibling paths is counted once in each; sibling counts therefore sum to **more** than the total doc count, and that is right for facets. (Contrast §9, where the identical duplication is a *lie*.)

**The sharp caveat — `hierarchicalMenu` is SINGLE-SELECT.** Algolia states it flatly: *"Disjunctive facets with hierarchical facets aren't possible"* [19][20]. `toggleFacetRefinement()` on a hierarchical facet **replaces** the current path; it does not accumulate. So you can *encode* "item is in group A and group B", but you **cannot express the query "show me items in A OR B"** through one `hierarchicalMenu`.

**Consequence for zodal-groups:** adopt the *data contract*, adopt the *item tree shape*, adopt the *renderer* — but **do not adopt InstantSearch's refinement semantics**. Disjunctive multi-path refinement is table stakes for a DAG library. Our core owns `selectedPaths: string[]` with a configurable `AND | OR` combination strategy. **This is a feature that justifies zodal-groups existing.**

**Not backend-locked.** InstantSearch accepts a custom `searchClient` [21]. Proven adapters: `typesense-instantsearch-adapter` (Apache-2.0, 3.0.2 — 2026-03-13, ~125k/wk) [22], `@meilisearch/instant-meilisearch` (MIT, 0.31.2 — 2026-06-18, ~29k/wk) [23], `@searchkit/instantsearch-client` (Elasticsearch/OpenSearch) [24]. All use the same `lvl` convention.

### 8.4 Client-side engines — who actually computes FACET COUNTS?

| Library | License | Latest | Maintenance | Facet **counts**? | Disjunctive? | Multi-value fields? | Hierarchical? | Weekly DL | Size |
|---|---|---|---|---|---|---|---|---|---|
| **`itemsjs`** | Apache-2.0 | 2.4.4 — 2025-11-25 | Niche but **quietly healthy** (403★, **0 open issues**, active commits) | **YES** — `data.aggregations` buckets | **YES** (`conjunction: false`) | **YES** | No (use materialized paths) | **3,094** | 17.4 kB |
| `@orama/orama` | Apache-2.0 | 3.1.18 — 2025-12-19 | Very active (10.5k★) | **YES** — `results.facets` | **BROKEN** — see below | Yes | No | ~1.18M | 23.8 kB |
| `minisearch` | MIT | 7.2.0 — 2025-09-16 | Active | **NO** | — | — | No | ~1.37M | 5.7 kB |
| `lunr` | MIT | **2.3.9 — 2020-08-19** | **DEAD** (~6 years) | **NO** | — | — | No | ~5.4M (inertia) | 8.1 kB |
| `fuse.js` | Apache-2.0 | 7.4.2 — 2026-06-05 | Active | **NO** — fuzzy matching only | — | — | No | ~11.1M | 9.0 kB |
| `flexsearch` | Apache-2.0 | 0.8.212 — 2025-09-06 | Active | **NO** (tag *filters*, no aggregation API) | — | Tags | No | ~1.07M | 16.4 kB |
| `sift` | MIT | 17.1.3 — 2024-04-17 | Stagnant but complete | **NO** — it's a Mongo-query predicate compiler | — | — | — | ~4.9M | 3.1 kB |

**Orama's disjunctive faceting is broken** — independently reported and corroborated in source: *selecting an option removes values from the same facet, when it should only affect other facets* [25][26]. That is precisely the count every faceted UI needs, and Orama gets it wrong. It also lacks facet-option limits and numeric min/max. Great full-text engine; naive facet counter. **Do not use Orama for faceting.**

**`itemsjs` is the only client-side engine with correct faceting semantics** — conjunction/disjunction per facet, `hideZero`, sort-by-count/key, selected-first, numeric min/max [27][28]. It's tiny (3.1k weekly downloads) but has **zero open issues** and ships releases. TypeScript support is thin (hand-written defs) — verify before depending on it.

**`sift` deserves a separate note:** it isn't a search engine, it's a `filterToFunction()` for MongoDB query syntax — the direct analogue of what `@zodal/store` already has. **Don't add it; we have our own.**

### 8.5 Recommendation — surface 8

**PRIMARY: adopt the `algoliasearch-helper` / InstantSearch *data contract*, own the *refinement state*, wrap the *connectors* for rendering.**

1. **`@zodal/groups-core` emits the facet tree itself.** We *have* the DAG — we can compute per-path counts exactly (including multi-path membership) with no search engine at all. Emit nodes shaped `{label, value, count, isRefined, data[]}`, deliberately structurally identical to `HierarchicalMenuItem`, so any InstantSearch renderer consumes them with a zero-cost adapter.
2. **Adopt `lvl0/lvl1/lvl2` + `separator` + array-of-paths as the *serialization* contract** for external indexes. It is the only battle-tested multi-parent facet encoding, and Algolia / Typesense / Meilisearch all understand it.
3. **Own the refinement state** — support disjunctive (`OR`) multi-path selection, the thing InstantSearch explicitly cannot do.
4. **Renderer satellite** wrapping `useHierarchicalMenu` / `connectHierarchicalMenu` / `connectBreadcrumb` (MIT, headless, agnostic at the `instantsearch.js` layer).

**FALLBACK (when the DAG isn't the source of truth and you need counts over a document set): `itemsjs`**, fed materialized path strings — Algolia's trick, applied client-side.

**REJECT:** lunr (dead), minisearch / fuse / flexsearch (no facet counts at all), Orama-for-faceting (broken disjunctive counts).

---

## 9. Treemap / sunburst / icicle

### 9.1 Status lines

| Library | License | Latest | Maintenance | Headless? | Framework | Weekly DL | Size (gz) | Space-filling layouts |
|---|---|---|---|---|---|---|---|---|
| **`d3-hierarchy`** | **ISC** | 3.1.2 — **2022-04-02** | **Mature, not dead** — a *finished* D3 module; repo still maintained (pushed 2025-04-08) | **YES — pure math, zero DOM** | **Agnostic** | **~18.6M** | **5.5 kB** | treemap, partition (icicle + sunburst), pack, tree, cluster |
| `@visx/hierarchy` | MIT | 4.0.0 — 2026-06-11 | Active (visx 20.9k★) | No (React comps) — but **re-exports `d3.hierarchy`** | **React-only** | ~192k | 6.2 kB | `Treemap`, `Partition`, `Pack`, `Tree`, `Cluster` |
| `@nivo/treemap` / `sunburst` / `icicle` | MIT | 0.99.0 — **2025-05-23** | **Commits current but NO RELEASE IN 14 MONTHS** | No | **React-only** | 261k / 140k / **10.7k** | **116 kB** (treemap alone) | treemap, sunburst, icicle |
| **ECharts** | Apache-2.0 | 6.1.0 — 2026-05-19 | Very active (66.8k★) | **No — a rendering engine** | **Agnostic** (canvas/SVG) | ~3.46M | 359 kB full (tree-shakeable) | `treemap`, `sunburst` (+ `leafDepth` drill-down) |
| Observable Plot | ISC | 0.6.17 — **2025-02-14** | 17 months since a release; 338 open issues | No | Agnostic | ~561k | 125 kB | **NONE — `tree` and `cluster` marks only. No treemap/partition/icicle mark exists.** ✗ |
| Recharts | MIT | 3.9.2 — 2026-07-04 | Very active | No | **React-only** | ~46M | 141 kB | `Treemap`, `SunburstChart` (nested children only; no icicle) |
| plotly.js | MIT | 3.7.0 — 2026-07-03 | Active | No | Agnostic | ~870k | **1,329 kB gz** ⛔ | treemap, sunburst, **icicle**; accepts **flat `ids`/`parents`** |
| `d3-dag` | MIT | **1.2.2 — 2026-07-05** | Releasing actively, but the **maintainer has publicly stepped back**: *"primarily a framework for experimentation rather than an out-of-the-box solution"* | Yes (pure math) | Agnostic | ~63k | 41 kB | **Sugiyama node-link only — NO space-filling layouts** |

### 9.2 Can `d3-hierarchy` represent a DAG? **No. Verified in source. And the two entry points fail differently.**

**`d3.stratify()` throws.** `parentId` is read through a **single-valued accessor** (`d.parentId`) — multi-parent input is structurally unrepresentable. The source throws exactly five errors [29][30]:

| Error | Condition |
|---|---|
| `"ambiguous: <id>"` | **two nodes share the same id** |
| `"multiple roots"` | more than one node has a null `parentId` |
| `"no root"` | no node has a null `parentId` |
| `"missing: <id>"` | a `parentId` references an id not in the data |
| `"cycle"` | traversal leaves unvisited nodes |

Docs state it flatly: *"There must be exactly one root node in the input data, and no circular relationships."* The DAG failure is a fork: list a node twice with different `parentId`s → **`ambiguous`**; give it one row and pick one parent → **you silently discarded edges**.

**`d3.hierarchy()` does something worse: it silently duplicates.** The nested-object traversal has **no `visited` set and no cycle detection** [31]:

```js
while (node = nodes.pop()) {
  if ((childs = children(node.data)) && (n = (childs = Array.from(childs)).length)) {
    for (i = n - 1; i >= 0; --i) {
      nodes.push(child = childs[i] = new Node(childs[i]));   // ← new Node() EVERY time
```

A shared child object under two parents becomes **two distinct `Node` instances** — no error, no warning. A cycle → infinite loop / OOM.

> **Verdict: `d3-hierarchy` is strictly a tree library. `stratify` refuses a DAG; `hierarchy` lies about one.**

And **everything downstream inherits this**, because everything *is* d3-hierarchy underneath: `treemap`, `partition`, `pack`, `tree`, `cluster` all take a `d3.hierarchy` root; visx wraps it; nivo wraps it; Recharts reimplements the same squarify; plotly's flat `ids`/`parents` arrays look DAG-ish but `parents[i]` is **one parent per entry** — `stratify` by another name.

### 9.3 The standard workaround — path expansion — and its exact cost

**Turn the DAG into a tree by materializing every distinct root→node path as its own tree node.** An item reachable by *k* distinct paths becomes *k* separate nodes. d3 even ships the vehicle: **`d3.stratify().path()`** — *"a unix-like hierarchy is computed on the slash-delimited strings returned by the path accessor, imputing parent nodes and ids as necessary"* [30]. **This is the identical trick to Algolia's array-of-paths encoding in §8.3.** Two ecosystems converging on the same serialization is a strong signal it's the right one.

**But say this plainly to users — it is not free:**

1. **`node.sum(v)` DOUBLE-COUNTS.** An item in *k* groups contributes its value *k* times. Ancestor rectangle areas overstate. Total treemap area ≠ total value of the item set.
2. **Path count explodes.** *k* is multiplicative down the DAG. Cap depth / cap paths and report the blow-up honestly.
3. **Selection becomes many-to-one.** One item ⇒ *k* rectangles; hovering one must highlight all *k*, or the UI lies about "where" the item is.
4. **Weight-splitting (`value / k`) is *not* a fix** — it restores area conservation but makes every individual rectangle a fraction of the truth. A different lie.

> **For a DAG, area-conservation and visual containment are mutually exclusive. There is no correct space-filling treemap of a DAG. Full stop.**

**Design implication (the ecosystem's "honest capability reporting" rule):** every emitted layout node should carry `{ pathCount: k, isDuplicate: boolean, canonicalId }`, and the layout config should take an explicit `valueStrategy: 'duplicate' | 'split' | 'primary-parent'` — **with no default that hides the tradeoff.** Renderers can then mark duplicates (hatching, badge, linked hover).

### 9.4 Recommendation — surface 9

**PRIMARY: `d3-hierarchy` as pure layout math, isolated in a `@zodal/groups-viz` (or `-layout`) package.**

It is the **only** candidate that is layout math with no rendering engine attached — zero DOM, zero framework — which is exactly the separation our architecture demands. ISC, 5.5 kB, ~18.6M weekly downloads, and it's what every other candidate is built on, so our config objects are natively consumable by visx, nivo, and hand-rolled SVG alike. Its "no release since 2022" is **completion, not stagnation** (the repo still receives maintenance commits).

Pipeline: `DAG → path-expand (ours) → d3.stratify().path() → d3.treemap() / d3.partition() → emit plain rects/arcs`:

```ts
type TreemapNode  = { path: string; label: string; value: number;
                      x0:number; y0:number; x1:number; y1:number;
                      depth:number; pathCount:number; isDuplicate:boolean };
type SunburstNode = { path: string; label: string; value: number;
                      x0:number; x1:number;   // angle
                      y0:number; y1:number;   // radius
                      depth:number; pathCount:number; isDuplicate:boolean };
```

Keep `@zodal/groups-core` dependency-free (it emits the *expanded tree*); let the viz package own the single `d3-hierarchy` dep.

**FALLBACK / renderer targets** (all consuming our config objects): **`@visx/hierarchy`** for React (MIT, active, 6.2 kB, has `Treemap` *and* `Partition` → icicle *and* sunburst; the thinnest possible React shell over the exact math we already run). **ECharts** for framework-agnostic (Apache-2.0, very active, treemap + sunburst with `leafDepth` drill-down; heavy but tree-shakeable, and it's a rendering engine that takes our data rather than dictating our model).

**REJECT:** **Observable Plot** — no treemap/partition/icicle mark exists; verified, and it's a missing feature, not a maintenance question. **nivo** — 14 months without a release despite live commits, 116 kB for treemap alone, and `@nivo/icicle` at 10.7k/wk is barely exercised. **plotly.js** — 1.33 MB gzipped is disqualifying for a library dependency. **`d3-dag` for *this* surface** — it is genuinely DAG-native (`parentIds`, plural — the only such library in the survey) but it produces **node-link** layouts only, no space-filling ones. It cannot draw a treemap. It belongs to surface 10, not here.

---

## 10. Graph rendering for the group-DAG itself (containment)

### 10.1 The load-bearing constraint

I checked every containment-capable renderer individually. **Not one of them supports multi-parent containment.** All model containment as a strict single-parent tree:

| Renderer | Containment field | Arity |
|---|---|---|
| ELK | nested `children: []` | one parent (a node lives in exactly one `children` array) |
| Cytoscape.js | `data.parent` | **string** — singular |
| React Flow | `parentId` | **string** — singular |
| AntV G6 | `combo` | **string \| null** — singular |
| dagre / graphlib | `setParent(v, parent)` → `parent(v): string \| void` | **singular** |
| Graphviz | `subgraph cluster_*` | *"clusters form a strict hierarchy"* — its own docs [32] |

**Consequence:** our core cannot emit "containment" as one concept and expect any renderer to draw it. It must emit a **two-part projection**:

- a **canonical spanning tree** — one designated *primary parent* per node (the nesting a renderer can actually draw), plus
- a **residual edge set** — every *other* parent link, rendered as an edge/cross-reference rather than as nesting.

**Make the primary-parent selection a pluggable, injected policy.** It is the single most important config object the core emits. (Notably, the one real polyhierarchy widget on npm arrived at exactly this design independently — see §12.)

### 10.2 Status lines

| Library | License | Latest release | Maintenance | Headless? | Framework | Weekly DL | Size (gz) |
|---|---|---|---|---|---|---|---|
| **`elkjs`** 0.11.1 | **EPL-2.0** ⚠️ | 2026-03-03 | **Active** — repo pushed 2026-07-13; steady 2–4 releases/yr | **Yes — pure layout, emits coordinates, no DOM** | Agnostic | **~2.86M** | **423 kB** ⚠️ |
| **`d3-dag`** 1.2.2 | MIT | **2026-07-05** | Releasing actively (repo pushed 2026-07-12, only 3 open issues) — **but the maintainer has publicly stepped back**: *"since [I] no longer use it… primarily a framework for experimentation rather than an out-of-the-box solution"* [33] | **Yes — pure layout** | Agnostic, TS-first | ~63k | **41 kB** |
| **Cytoscape.js** 3.34.0 | MIT | 2026-06-02 | Very healthy (**13 open issues** on 10.9M/wk — exceptional triage) | Renderer (has a `headless: true` mode) | Agnostic | **~10.9M** | 132 kB |
| **`@xyflow/react`** 12.11.2 | **MIT** ✅ | 2026-07-06 | Very active (37.6k★) | No — it *is* the renderer | React (+ `@xyflow/svelte`, ~182k/wk) | ~6.7M | 57 kB |
| **`@dagrejs/dagre`** 3.0.0 | MIT | 2026-03-22 | **Revived** (TS rewrite) | **Yes — pure layout** | Agnostic | ~2.39M | **13 kB** |
| `@viz-js/viz` 3.28.0 | MIT | 2026-06-03 | Active | Emits an SVG **string** | Agnostic (WASM) | ~109k | 524 kB |
| `sigma` 3.0.3 | MIT | 2026-04-30 | Active | No — WebGL renderer | Agnostic | ~265k | 25 kB |
| `@antv/g6` 5.1.1 | MIT | 2026-05-08 | Active but **331 open issues**; CN-first docs | No | Agnostic | ~240k | heavy |
| `vis-network` 10.1.0 | Apache-2.0/MIT | 2026-05-15 | ⚠️ Alive but **344 open issues** / 3.6k★ — caretaker mode | No | Agnostic | ~486k | — |
| `webcola` 3.4.0 | MIT | **2019-05-10** ☠️ | **npm-dead — 7 years** | Yes | Agnostic | ~255k | — |
| ~~`dagre` 0.8.5~~ / ~~`graphlib` 2.x~~ | MIT | **2019** ☠️ | **DEAD — use the `@dagrejs/*` scope** | — | — | 2.5M (legacy inertia) | — |

### 10.3 ELK — verified in detail, and it's the answer

- **`elk.hierarchyHandling`** confirmed [34]: `INHERIT | INCLUDE_CHILDREN | SEPARATE_CHILDREN`. *"Setting a node's hierarchy handling to `INCLUDE_CHILDREN` will lay out that node and all of its descendants in a single layout run."*
- **Nested `children` arrays** confirmed [35]: *"A graph is actually nothing more than a simple node whose children are the top-level nodes of the graph."*
- **Hierarchy-crossing edges — ELK's killer feature** [35]: *"any edge may be defined under any node, regardless of its end points. This allows for flexibility when defining hierarchy-crossing edges."* Plus hyperedges via `sources[]`/`targets[]`. **No other layout engine offers this.** Our residual (non-primary) parent edges will route correctly *through and across* group boxes.
- **Maintenance: active.** 0.9.1 (2024-01) → 0.10.0 (2025-03) → 0.11.0 (2025-09) → **0.11.1 (2026-03-03)**; repo pushed 2026-07-13.
- ⚠️ **License: EPL-2.0.** Weak copyleft, file-level. Bundling *unmodified* elkjs in a permissive app is fine with attribution, but **modifying elkjs sources obliges you to publish that module's source**, and EPL-2.0 is **GPL-incompatible by default** [36][37]. **Flag this loudly.** Keep elkjs an **optional peer dependency**, never a hard dep of core, so users who cannot take EPL aren't forced to.
- ⚠️ **Size: 423 kB gzip** — it's a GWT (Java→JS) transpile of Eclipse ELK. **But it runs in a web worker** (`new ELK({ workerUrl })`), which largely neutralizes this: the 423 kB never touches the main thread and layout never blocks the UI.

**ELK's DAG verdict:** the *containment tree* is single-parent, **but the edge graph is a full DAG and edges may freely cross hierarchy levels.** ELK is therefore the only engine that natively renders the §10.1 projection — primary parent as nesting, extra parents as hierarchy-crossing edges — in a single layout pass.

### 10.4 The others

- **Cytoscape.js — single parent, confirmed.** *"Compound nodes are specified via the `parent` field in a node's data… the `parent` field is normally immutable"* [38]. The field is `parent` (string), not `parents`. **Open issue #2220, "Overlapping compound nodes"** [39] is a *feature request* from someone building a Bayesian-network editor who needed exactly a two-parent node — i.e. explicitly unbuilt. What breaks: you must pick one canonical parent, and every other parent link degrades to a plain edge losing all containment semantics. No overlapping group boxes, no Euler-diagram look. Also *"a compound parent node does not have independent dimensions"* — you can't hand-place group boxes.
- **React Flow (`@xyflow/react`) — MIT confirmed** (the relicensing worry is unfounded; xyflow monetizes via a Pro *support* plan). Sub-flows use **`parentId` (singular)** + `extent: 'parent'` [40]. **Single parent only.** It ships **no layout engine** — you're expected to bring ELK or dagre. So it is a *consumer* of §10's answer, not a competitor to it.
- **Sigma.js + graphology — no containment, confirmed.** WebGL renderer for 10k+ nodes; no nesting, no compound nodes. graphology's community detection is clustering-as-*coloring*, not visual containment. Keep Sigma for the "big graph, no boxes" mode only.
- **`@dagrejs/dagre` — revived, and it does compounds.** `@dagrejs/graphlib` has `compound: true`, `setParent()`, `parent()`, `children()`; `@dagrejs/dagre` ships `nesting-graph.ts` / `parent-dummy-chains.ts` / `add-border-segments.ts` — an implementation of Sander's *"Layout of Compound Directed Graphs."* **Multi-parent: no** (`parent(v)` returns one string). But MIT and **13 kB** — the escape hatch if ELK's EPL-2.0 or 423 kB is a dealbreaker, at the cost of weaker hierarchy-crossing-edge routing. **Important:** the old `dagre@0.8.5` / `graphlib@2.x` (2019) are **dead** despite still pulling millions of downloads from legacy dependents. Use the `@dagrejs/*` scope.
- **`d3-dag` — the mirror image of ELK.** **Multi-parent: YES, natively** — it uses **`parentIds` (plural)**, the only library in this whole survey that treats a multi-parent DAG as its primary data model. But **containment: NO, explicitly** — its docs list under unsupported features: *"Compound graphs: `setParent`, `parent`, `children`"* [33]. Layouts: sugiyama, zherebko, grid.
- **Graphviz-WASM (`@viz-js/viz`, MIT, 524 kB)** — `subgraph cluster_*` is the original containment renderer and still produces the best-looking *static* clusters. But clusters form a strict hierarchy [32], and the output is an **SVG string**, not an interactive scene graph — no hit-testing, no dragging, no incremental re-layout. It is an **export target**, not a UI.
- **Reject:** G6 (single-parent `combo`, 331 open issues, CN-first docs, heavy runtime), vis-network (344 open issues on 3.6k★), **WebCola (npm-dead 7 years** — a pity, its constraint-based nested groups with padding are genuinely interesting).

### 10.5 Recommendation — surface 10

**Ranking for "taxonomy DAG with containment": ELK > d3-dag > graphviz-wasm > Cytoscape.**

**PRIMARY: `elkjs`** — `elk.layered` + `hierarchyHandling: INCLUDE_CHILDREN`, in a **web worker**, as an **optional peer dependency**. It is the only engine that lays out compound/nested nodes **and** hierarchy-crossing edges in one pass — precisely the spanning-tree-plus-residual-edges projection a group-DAG requires. Headless, agnostic, actively maintained. ⚠️ **EPL-2.0 and 423 kB are real costs — make them opt-in.**

**FALLBACK / COMPLEMENT: `d3-dag`** (MIT, 41 kB, native `parentIds`) for the **"pure DAG, no boxes"** view and as the MIT escape hatch from EPL-2.0 — with the honest caveat that its maintainer has publicly stepped back. Second fallback for containment-on-a-budget: **`@dagrejs/dagre`** (MIT, 13 kB, compound graphs, revived).

**Interchange format:** emit **ELK JSON** (`{id, children[], edges[], layoutOptions}`). React Flow's `parentId`/`extent` and Cytoscape's `data.parent` are both trivially derivable from it, and our sibling graph package already wraps ELK/React Flow/Sigma/graphology.

---

## 11. Utility / graph-algorithm libraries

| Library | License | Latest release | Maintenance | TS types | Weekly DL | Size |
|---|---|---|---|---|---|---|
| **`graphology`** 0.26.0 | MIT | 2025-01-26 | ⚠️ **Slowing** (repo pushed 2025-12-03; recent commits are dep bumps, not features; 84 open issues) | Bundled | ~1.13M | 13 kB |
| **`graphology-dag`** 0.4.1 | MIT | ⚠️ **2023-12-09** | **Stagnant — but complete** (see below) | Yes | ~207k | tiny |
| **`@dagrejs/graphlib`** 4.0.1 | MIT | **2026-03-08** | **Active** (TS rewrite) | Native TS | **~2.73M** | small |
| `digraph-js` 2.2.4 | MIT | 2025-11-06 | Active, zero-dep | Yes | ~87k | small |
| `ngraph.graph` | MIT | — | Active | Partial | ~284k | minimal |
| `js-graph-algorithms` | MIT | ancient | ☠️ **Dead** | No | ~80k | ES5 |

**`graphology-dag` exists and does exactly what we need:** `hasCycle`, **`willCreateCycle`**, `topologicalSort`, `topologicalGenerations`, `forEachNodeInTopologicalOrder` [41]. **`willCreateCycle(graph, source, target)` is precisely the guard zodal-groups needs before committing an "add parent" edit** — without it a polyhierarchy silently becomes a cyclic mess.

**Honest maintenance read:** graphology is *slowing*, not dead (core last published 2025-01-26; `graphology-dag`'s last release was 2023-12-09 — over 2.5 years ago). **This is acceptable, for a specific reason:** `graphology-dag` is a few hundred lines of *textbook, finished* algorithms. Stagnation on a completed algorithm library is a very different risk from stagnation on a renderer.

### 11.1 Incremental transitive closure — I searched hard, and there is essentially nothing

**I searched the npm registry for the literal term `"transitive closure"`. The results were: `google-closure-compiler`, `tsickle`, `google-closure-library`, `google-protobuf`.** There is **no** `transitive-closure` package, **no** `dag-map`, and **no** GRAIL / interval-labeling / nested-set reachability index on npm. A web search returns **only academic papers** (Demetrescu & Italiano [42]; recent SEA/Dagstuhl work [43]) — **zero JS implementations.**

**The single real hit:**

> ### `hierarchy-closure` — the closest thing that exists
> **MIT | v1.2.2, 2023-11-05 | repo pushed 2024-06-20 | ~1.9k weekly DL | 0★ | zero dependencies** — by Eric Prud'hommeaux (W3C; author of ShEx) [44]
>
> **It maintains a transitive closure incrementally, with multi-parent support.** `add(parent, child)` may be called **in any order** and yields the same closures. It keeps two maps — `parents` (child → *all* ancestors) and `children` (parent → *all* descendants) — both **arrays**, so a node can have many parents.
>
> ⚠️ **Limits:** **append-only — no edge removal**, which is precisely the hard half of *dynamic* transitive closure and exactly what we need "under edit." No documented cycle detection. 0 stars, one author, effectively a personal utility extracted from `shex.js`.
>
> **Verdict: take the idea, not the dependency.**

**Near-misses:** `digraph-js` (MIT, active, 87k/wk — real ancestor/descendant traversal and deep cycle detection, but **computed on demand, no maintained index**: O(V+E) per query). `hylar` (an *incremental* RDF reasoner — right shape, **dead since 2021**). `@hapi/topo` / `topological-sort` / `tsort` — topological sort only, no reachability.

**DB-side prior art, and whether JS ports it:**
- **Postgres `ltree`** — materialized path, **TREE ONLY**: one path per node ⇒ exactly one parent. **Structurally incapable of polyhierarchy.** Every JS package in this space (`prisma-ltree`, `graphile-ltree`, path-string helpers) inherits that limit. **No JS port of ltree semantics to a DAG exists.**
- **Recursive CTEs** — DAG-correct, but compute-on-demand with no index, and it's SQL.
- **Closure tables** — store every `(ancestor, descendant, depth)` pair. **This is the DAG-correct design and the one to port.** But TypeORM's closure-table mode is single-parent (§12), so it can't be reused. **Nobody has shipped a JS closure table for DAGs.**

### 11.2 Recommendation — surface 11

**PRIMARY: `graphology` + `graphology-dag`** (MIT, 13 kB, bundled TS types) — our sibling graph package already wraps graphology, so this is ecosystem coherence for free. Use `willCreateCycle` as the edit guard and `topologicalSort` for ordering.

**FALLBACK: `@dagrejs/graphlib`** — 2.73M/wk, actively maintained (2026-03-08), native TypeScript, and it ships compound-graph support built in. A drop-in if graphology's slowdown becomes a problem.

**WRITE THE INCREMENTAL TRANSITIVE CLOSURE OURSELVES. No library exists — this is a genuine gap and it is zodal-groups' most defensible piece of engineering.** Concretely: maintain a **closure table** (`ancestor → Set<descendant>` plus its inverse) so `isDescendant(x, y)` is **O(1)**; incremental *add* is easy (inserting `u→v` adds `(anc(u) ∪ {u}) × (desc(v) ∪ {v})`, and `hierarchy-closure` is the reference implementation); **incremental delete is the hard part where every existing package gives up** — but at taxonomy scale (thousands, not millions, of nodes) **recompute-affected-subgraph on delete is entirely adequate.** Don't over-engineer a fully-dynamic algorithm. Guard every insertion with `willCreateCycle`.

---

## 12. Prior art: existing polyhierarchy / taxonomy JS libraries

### 12.1 The headline

**I searched npm for the literal term `polyhierarchy`. It returned exactly ONE package.** Not one *good* one — **one, total.** The expectation was right: **there is essentially no prior art.** Here is the proof, with the near-misses reported honestly.

### 12.2 The four honest near-misses

> #### `dag-browser-widget` — the best prior art that exists, and it is two weeks old
> **⚠️ GPL-3.0-or-later | v0.2.0, 2026-06-29 | 9 weekly DL | 0★ | zero runtime deps** — by Sigfried Gold (OHDSI, where OMOP medical-vocabulary polyhierarchies are a daily reality) [45]
>
> Self-description: *"Dependency-free logic + a thin React view for browsing a **DAG (polyhierarchy)** as a collapsible tree, **de-duplicating nodes that appear under multiple parents.**"*
>
> **Its architecture is our architecture.** `dag-browser-widget/core` is *"~400 lines of dependency-free TypeScript. **No React, no DOM.** Unfolds the DAG, computes which rows are visible under collapse, computes the rails, the also-under cross-references, and the reveal-at links"* — with a thin React view on top. Its UX solves exactly our problem: a node with several parents is **unfolded once in full**, and its other parents become compact **`★ also under …`** links instead of duplicate subtrees; cycles become **`⟲ loops back to …`** markers instead of infinite recursion.
>
> ⚠️ **GPL-3.0 — we cannot vendor it or depend on it** from a permissively-licensed library. 0 stars, 9 downloads/week, v0.2.0, browsing only (no grouping model, no store, no query, no editing).
>
> **Why it matters enormously:** it is **independent confirmation** that (a) headless-core-plus-thin-view is the right shape and (b) unfold-once-plus-cross-reference is the right polyhierarchy UX. **Study it. Do not import it.**

> #### `tag-hierarchy` — the right philosophy
> **MIT | v0.2.1, 2026-06-13 | 15 weekly DL | zero-dep, framework-agnostic** [46]
>
> Its thesis line is excellent: ***"A hierarchy is a lossy projection of a flat tagged relation."*** Hand it flat `{id, tags}` items plus a declarative query and it returns a tree, projected on demand: *"Storage stays flat; structure, grouping, and ordering all fall out of one tag mechanism."*
>
> **Not our library** — it does tag→tree faceted projection, not a group-DAG (no group nodes, no groups-of-groups, tags are flat strings). But **its framing is exactly the philosophy zodal-groups should adopt**, and it converges with the spanning-tree-plus-residual-edges design of §10.1. **15 downloads/week: nobody is using it. The field is wide open.**

> #### SKOS / JSKOS — the real domain prior art (and `skos:broader` IS natively polyhierarchical)
> **`@openactive/skos`** has `getBroader` / **`getBroaderTransitive`** / `getNarrowerTransitive` — the exact transitive traversal we want — but it's **locked to OpenActive JSON-LD, ES5, and dead since 2021-03-24** ☠️ (105 weekly DL). **The closest domain fit in existence, and it is a corpse.**
> **`jskos-tools`** (MIT, GBV/German library network, **actively maintained — 2026-06-25**) [47] is the most rigorous polyhierarchy *data model* in JS (`broader` is an array), with a whole live ecosystem — but the tools are validation/conversion/mapping only: **no ancestor–descendant traversal, no DAG index, no UI.**
>
> **The entire RDF/SKOS stack is alive, but NOT ONE package ships a SKOS broader/narrower traversal helper.** `rdflib` (14.5k/wk), `n3` (194k/wk), `sparqljs`, `@comunica/query-sparql` — all generic; you'd hand-write `skos:broader+` property paths against a triple store, enormously heavy for what is fundamentally a small in-memory DAG. **Do not build on RDF. But DO steal SKOS's semantics** — `broader`/`narrower` (multi-valued), `related` (associative, non-hierarchical), `topConcept`, `broaderTransitive`. It's the only battle-tested vocabulary for polyhierarchy, it's a W3C Recommendation, and aligning with it is free.

> #### `hierarchy-closure` — see §11.1. MIT, append-only, 0★. Take the algorithm, not the dependency.

### 12.3 Everything else — confirmed single-parent

**Tree builders — every one of them assumes exactly one parent:**

| Package | Latest | Weekly DL | Parent field | Verdict |
|---|---|---|---|---|
| `treeify` | **2018-02-16** | ~2.95M | n/a | Console pretty-printer. Irrelevant. |
| `performant-array-to-tree` | **2022-02-17** | ~27k | `parentId` singular | ❌ Single parent |
| `array-to-tree` | **2019-12-07** ☠️ | ~21k | `parent_id` singular | ❌ Single parent, dead 7 yrs |
| `flat-to-nested` | 2026-06-10 | ~11k | `parent` singular | ❌ Single parent |
| `hierarchy-js` | — | — | — | Not meaningfully present on npm |

Feed any of them a DAG and one of two things happens: **edges are silently dropped** (last parent wins), or **subtrees duplicate combinatorially** (and on a cycle, it never terminates). **None is a starting point.**

**ORM tree plugins — single-parent in all four modes.** TypeORM's `@Tree` supports `adjacency-list`, `nested-set`, `materialized-path`, **and `closure-table`** — but the decorator is [48]:

```ts
@TreeParent()
parent: Category      // ← SINGULAR. Not `parents: Category[]`.
```

**`@TreeParent` is singular in ALL FOUR modes, including `closure-table`** — the one pattern that *could* have supported a DAG. TypeORM stores only `(ancestor, descendant)` pairs derived from a single-parent tree. Same for `mongoose-mpath`, `mongoose-materialized`, `ts-nested-set`. **Confirmed: no multi-parent support anywhere in the ORM world.**

**CMS / DAM world:**
- **`sanity-plugin-taxonomy-manager`** (MIT, v4.7.2, **2026-05-11, actively maintained**) [49] — *"Create and manage SKOS compliant taxonomies, thesauri, and classification schemes in Sanity Studio."* **The most mature taxonomy authoring UI in the JS world — and it is completely Sanity-locked** (React + `@sanity/ui` + `styled-components` + `rxjs`). **Its existence and health is proof of demand for exactly what we're building, minus the CMS lock-in.**
- **Contentful / Strapi** — tags are flat; no polyhierarchical taxonomy primitive.
- **WordPress** — `wp_term_taxonomy` has a **single `parent` bigint column**. No polyhierarchy.
- **Drupal — the exception, and a cautionary tale.** Core has supported taxonomy terms with **multiple parents since 8.9**. But the feature is half-broken in practice: **a term has only one `weight`**, so it can't carry a distinct ordering per parent — meaning **you cannot drag-and-drop a term that has multiple parents** [50].
  > **Lesson, and bake it in from day one: ordering/weight belongs on the (parent, child) EDGE, not on the node.** A mature system learned this the hard way.

**Also checked:** `taxeme` (Apache-2.0, v0.0.1) — its README literally says *"This is a namespace reservation. The real package will be published from the taxeme monorepo."* **No code exists.** Standalone `closure-table` / `materialized-path` npm packages: **do not exist** in usable form.

### 12.4 Verdict — surface 12

**PROVEN: there is no good prior art. Build it.** The evidence, precisely:

1. npm's entire inventory for `"polyhierarchy"` is **one two-week-old GPL widget with 9 downloads/week**.
2. npm's entire inventory for `"transitive closure"` is **the Google Closure Compiler**.
3. **Every** tree builder, **every** ORM tree plugin (including closure-table mode), and **every** graph renderer's containment model is **strictly single-parent**.
4. The only stack that models polyhierarchy correctly — **SKOS/RDF** — ships **no traversal helper in JS** and is far too heavy.
5. The one mature taxonomy UI is **locked inside a CMS**.

---

## 13. The third renderer package — recommendation

The brief offers: Material UI, Ark UI/Zag.js, Mantine, Radix primitives, Lit/web components, Svelte, or a canvas/viz lib.

**RECOMMENDATION: Ark UI / Zag.js — and it should arguably be promoted above "third."**

The reasoning is leverage, not taste. A third *design-system* renderer (MUI, Mantine) proves nothing the vanilla renderer hasn't already proven, and it buys one framework. **Zag buys five.** One state machine ships official adapters for **React, Vue, Solid, Svelte, Preact and vanilla** [51], released in lockstep, MIT, monthly, WAI-ARIA compliant, ~2.2 kB core. Ark UI is the unstyled component layer on top [63] (45+ components: TreeView, Combobox, TagsInput, Collapsible, and the only headless cascader in existence).

That means `zodal-groups-ui-ark` is not "renderer #3" — it is **renderer #3 through #7**, and it is the only candidate that could *retroactively subsume the vanilla renderer* (`@zag-js/vanilla`), collapsing two of our satellites into one core with two adapters. **Flag the one honest risk:** `@zag-js/vanilla` is new (~1.6k weekly downloads) and unproven; validate it with a spike before betting the vanilla satellite on it.

**Rejected, with reasons:**
- **Material UI / Mantine** — design-system opinions that duplicate shadcn's coverage and buy one framework each. MUI additionally puts **tree DnD behind a paid Pro licence**, which is a licensing landmine for a feature we consider core.
- **Radix primitives** — **has no tree and no breadcrumb**, and shadcn has now moved its default to Base UI anyway [5]. Building on Radix in 2026 is building on the *previous* default.
- **Lit / web components** — framework-agnostic *distribution* is appealing, but it duplicates what the vanilla renderer already delivers while adding a custom-element interop tax.
- **Svelte** — a subset of what Zag gives us for free.

**The genuinely valuable "renderer #4", though, is a viz renderer** — ELK + React Flow / Cytoscape (§10) or d3-hierarchy treemap/sunburst (§9). It is the only surface that renders the DAG **as a DAG** rather than as a flattened tree, and it is where this library's differentiator actually lives. If we can only build one more after shadcn + vanilla, and the goal is to *demonstrate the thesis* rather than *broaden framework reach*, build the viz renderer instead.

---

## 14. Consolidated decision table

| # | Surface | PRIMARY | FALLBACK | License | DAG-safe? | Notes |
|---|---|---|---|---|---|---|
| **0** | **DAG → visible rows projection** | **Build it in `@zodal/groups-core`** — path-keyed, lazy, cycle-guarded | — | ours | ✅ **by construction** | **No library does this.** Everything else in this table depends on it. |
| 1 | Headless tree state | **`@headless-tree/core`** driven with **synthetic path IDs** | **Zag `@zag-js/tree-view`** (multi-framework) | MIT / MIT | ✅ *only via path IDs* | Both are **ID-keyed** natively → a node under 2 parents expands in both. Identity is user-supplied, so path IDs fix it. |
| 1b | Row/column rendering of the tree | **`@tanstack/table-core`** — `getRowId: r => r.key` | — | MIT | ✅ **path-keyed by default** | Already wrapped by a sibling. ⚠️ **Do NOT use `getSubRows`** — eager materialization, exponential on a DAG. |
| 2 | Virtualization | **`@tanstack/virtual-core`** | `virtua` | MIT / MIT | ✅ (if rows are path-keyed) | Only candidate that is **both** headless and framework-agnostic → serves shadcn *and* vanilla. react-window / react-virtuoso are React-only. |
| 3 | Drag and drop | **`@atlaskit/pragmatic-drag-and-drop`** + `-hitbox` | **dnd-kit "next"** (`@dnd-kit/dom`) | **Apache-2.0** / MIT | ✅ semantics-agnostic | pdnd's `Instruction` / `Operation` model **is** our config-object model. Modifier keys in the payload ⇒ *Alt+drop = add-a-parent*. dnd-kit **v6 is frozen**; its 16M downloads are a trap. |
| 4 | Miller columns | **BUILD IT** (~200 lines) | — | ours | ✅ **natively — best DAG view** | Category is a **graveyard** (best entry: 7★, 53 dl/wk; GOV.UK's was **archived 2025-08-28**). Path-oriented by nature ⇒ no duplicate-subtree problem. |
| 5 | Breadcrumbs | **shadcn `Breadcrumb` + `BreadcrumbEllipsis` + `DropdownMenu`** | `<details>` in vanilla | MIT | ⚠️ we add multi-path | **No library does multi-path** — and NN/g *advises against it*. Radix has **no breadcrumb primitive at all**. Default to one primary path, alternates one click away. |
| 6 | Tag / token input | **`@zag-js/combobox` + `@zag-js/tags-input`** | **`@base-ui/react` Combobox** (React only) | MIT / MIT | ✅ via `nodeToValue` | Only one-level grouping anywhere. ⛔ **cmdk stagnant (16 mo, repo handed over) + renders DOM.** ⛔ **react-select styled + 488 open issues.** ☠️ `@mui/base` **deprecated**. |
| 7 | Tree select / cascader | **`@zag-js/tree-view` in a popover + combobox filter** | **`headless-tree`** (React); **`@zag-js/cascade-select`** once out of Beta | MIT | ⚠️ cascaders double-count | `@zag-js/cascade-select` is the **only headless cascader in existence** (Beta, 5 months old). ⛔ **PrimeReact archived → v11+ is PAID.** ☠️ react-dropdown-tree-select dead. ⚠️ Use `@rc-component/*`, not frozen `rc-*`. |
| 8 | Faceted search | **Emit the `HierarchicalMenuItem` shape ourselves**; wrap `useHierarchicalMenu` / `connectHierarchicalMenu` to render | **`itemsjs`** (Apache-2.0) for counts over a doc set | MIT | ✅ **arrays of `lvl` paths = real multi-parent** | Algolia is the **only** stack with native multi-path facets — **but `hierarchicalMenu` is SINGLE-SELECT** (*"disjunctive facets with hierarchical facets aren't possible"*). **We must own refinement state.** ⛔ **Orama's disjunctive counts are broken.** ☠️ lunr dead. |
| 9 | Treemap / sunburst / icicle | **`d3-hierarchy`** (pure math, no DOM) | **`@visx/hierarchy`** (React) / **ECharts** (agnostic) | ISC / MIT | ❌ **strictly a tree** | `stratify` **throws** `ambiguous` on a DAG; `hierarchy()` **silently duplicates** (no visited set). Path-expansion is the only workaround and it **double-counts `sum()`**. Emit `pathCount` / `isDuplicate` / `valueStrategy`. ⛔ Observable Plot has **no treemap mark at all**. ⛔ plotly = 1.33 MB gz. |
| 10 | Graph rendering (containment) | **`elkjs`** — `hierarchyHandling: INCLUDE_CHILDREN`, in a **web worker**, **optional peer dep** | **`d3-dag`** (MIT, native `parentIds`) / **`@dagrejs/dagre`** (MIT, 13 kB) | ⚠️ **EPL-2.0** / MIT | ⚠️ single-parent nesting + **DAG edges that cross hierarchy** | **No renderer anywhere supports multi-parent containment.** ELK is the only one that does nesting **and** hierarchy-crossing edges in one pass. ⚠️ **EPL-2.0 is weak copyleft + GPL-incompatible; 423 kB gz.** Cytoscape/React Flow/G6/dagre/Graphviz: **all single `parent`**. |
| 11 | Graph algorithms | **`graphology` + `graphology-dag`** (`willCreateCycle` guards every edit) | **`@dagrejs/graphlib`** (active, native TS) | MIT | ✅ | `graphology-dag` last released **2023-12-09** — but these are *finished* textbook algorithms. Sibling already wraps graphology. |
| 11b | **Incremental transitive closure** | **WRITE IT** — closure table, O(1) `isDescendant` | — | ours | ✅ | **Nothing exists.** npm's inventory for "transitive closure" is *the Google Closure Compiler*. Model on **`hierarchy-closure`** (MIT, append-only). Recompute-affected-subgraph on delete is fine at taxonomy scale. |
| 12 | Prior art | **None adoptable — build it** | — | — | — | npm's entire inventory for "polyhierarchy" is **one 2-week-old GPL widget with 9 dl/wk**. Steal SKOS's vocabulary; study `dag-browser-widget`'s UX; **don't import either**. |
| 13 | Third renderer | **Ark UI / Zag.js** (React+Vue+Solid+Svelte+Preact+**vanilla** from one machine) | A **viz renderer** (ELK/Cytoscape or d3-hierarchy) | MIT | — | Zag is renderer #3–#7. The viz renderer is the one that shows the DAG *as a DAG*. ⛔ MUI (paid Pro DnD), Radix (no tree, no breadcrumb, no longer shadcn's default). |

### Headless-first violations and framework-opinion flags

| Library | Problem |
|---|---|
| **`sortablejs`** | **Mutates the DOM itself** — cannot be driven from a config object; fights React's reconciler. |
| **`cmdk`** | "Unstyled" ≠ headless — **it renders DOM**, and its internal scoring is keyed on a `value` string that **misranks duplicates**. |
| **`react-select`** | **Styled** — Emotion is a hard dependency. |
| **`react-arborist`** | Renders its own rows, bakes in virtualization, React-only, and pins the **dead** `react-dnd@^14`. |
| **`@mui/x-tree-view`** | Tree **DnD reordering is behind a paid Pro licence** — a commercial dependency for a core feature. |
| **PrimeReact** | **Archived; v11+ is a paid commercial licence.** |
| **`elkjs`** | **EPL-2.0** — weak copyleft, GPL-incompatible by default. Keep it an **optional peer dependency**. |
| **`swapy`** | **GPL-3.0** — disqualified outright for a permissively-licensed library. |
| **`dag-browser-widget`** | **GPL-3.0** — read it, don't import it. |
| **AntD / rc-\* / PrimeReact / MUI / Mantine** | Design-system opinions. Renderer-satellite material at most; never core. |

### Things that are dead or stagnant — say it plainly

☠️ **Dead:** `react-dnd` (2022-04), `react-tagsinput` (2023-06), `react-dropdown-tree-select` (2023-01), `lunr` (2020-08), `webcola` (2019-05), `dagre@0.8.5` / `graphlib@2.x` (2019), `array-to-tree` (2019), `@openactive/skos` (2021), `hylar` (2021), `dnd-kit-sortable-tree` (2023-07), `miller-columns-element` (**archived 2025-08**), `@mui/base` (**deprecated**), PrimeReact repo (**archived**).

⚠️ **Frozen or stagnant despite big download numbers:** `@dnd-kit/core` v6 (16.4M/wk, **last commit 2024-12**), `cmdk` (36.4M/wk, **last release 2025-03**, repo handed over), `react-select` (8.8M/wk, 488 open issues), `rc-tree-select` / `rc-cascader` (4.5M/wk combined, **superseded by `@rc-component/*`**), `treeify` (2.9M/wk, last release 2018), `nivo` (**14 months without a release**), Observable Plot (17 months), `graphology-dag` (2.5 years — but complete).

---

## REFERENCES

1. [headless-tree — documentation](https://headless-tree.lukasbach.com/)
2. [`@headless-tree/core` — npm](https://www.npmjs.com/package/@headless-tree/core)
3. [lukasbach/headless-tree — GitHub](https://github.com/lukasbach/headless-tree)
4. [Radix UI Primitives — component list (no tree, no breadcrumb)](https://github.com/radix-ui/primitives/tree/main/packages/react)
5. [shadcn/ui — "Base UI as the Default" changelog, July 2026](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
6. [ReUI — Tree component (built on `@headless-tree/core`)](https://reui.io/components/tree)
7. [`@tanstack/table-core` — `src/core/table.ts` (`_getRowId` path default)](https://cdn.jsdelivr.net/npm/@tanstack/table-core@8.21.3/src/core/table.ts)
8. [`@zag-js/collection` — `TreeCollection` API](https://www.npmjs.com/package/@zag-js/collection)
9. [`@zag-js/tree-view` — types (`expandedValue`, `selectedValue`)](https://www.npmjs.com/package/@zag-js/tree-view)
10. [MUI X — Rich Tree View ordering (`itemsReordering`, Pro plan)](https://mui.com/x/react-tree-view/rich-tree-view/ordering/)
11. [pragmatic-drag-and-drop — `hitbox/src/tree-item.ts` (the `Instruction` type)](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/packages/hitbox/src/tree-item.ts)
12. [pragmatic-drag-and-drop — `hitbox/src/list-item.ts` (`Operation` / `Availability`)](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/packages/hitbox/src/list-item.ts)
13. [pragmatic-drag-and-drop — `core/src/internal-types.ts` (modifier keys on `Input`)](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/packages/core/src/internal-types.ts)
14. [Nielsen Norman Group — Breadcrumbs: 11 design guidelines](https://www.nngroup.com/articles/breadcrumbs/)
15. [UI Patterns — Breadcrumbs](https://ui-patterns.com/patterns/Breadcrumbs)
16. [IBM APAR JR54092 — breadcrumb picks the wrong parent for a multi-parent category](https://www.ibm.com/support/pages/apar/JR54092)
17. [Algolia — `hierarchicalMenu` widget (JS API reference)](https://www.algolia.com/doc/api-reference/widgets/hierarchical-menu/js)
18. [Algolia — `useHierarchicalMenu` (React API reference)](https://www.algolia.com/doc/api-reference/widgets/hierarchical-menu/react)
19. [Algolia — Faceting guide (hierarchical facets, multi-path arrays, the disjunctive limitation)](https://www.algolia.com/doc/guides/managing-results/refine-results/faceting)
20. [Algolia Support — "Can I enable multiple selections using a hierarchical menu?"](https://support.algolia.com/hc/en-us/articles/13979706969361-Can-I-enable-multiple-selections-using-a-hierarchical-menu)
21. [Algolia — Implementing a custom `searchClient` (backend-agnostic InstantSearch)](https://www.algolia.com/doc/guides/building-search-ui/going-further/backend-search/in-depth/backend-instantsearch/js)
22. [typesense-instantsearch-adapter — GitHub](https://github.com/typesense/typesense-instantsearch-adapter)
23. [`@meilisearch/instant-meilisearch` — npm](https://www.npmjs.com/package/@meilisearch/instant-meilisearch)
24. [Searchkit — InstantSearch client (Elasticsearch / OpenSearch)](https://www.searchkit.co/docs/api-documentation/instantsearch-client)
25. [stereobooster — "Faceted search" (client-side engine comparison; Orama's disjunctive bug)](https://stereobooster.com/posts/faceted-search/)
26. [Orama — `packages/orama/src/components/facets.ts` (source)](https://github.com/oramasearch/orama/blob/main/packages/orama/src/components/facets.ts)
27. [itemsapi/itemsjs — GitHub](https://github.com/itemsapi/itemsjs)
28. [itemsjs — npm](https://www.npmjs.com/package/itemsjs)
29. [d3-hierarchy — `src/stratify.js` (source; the five error throws)](https://github.com/d3/d3-hierarchy/blob/main/src/stratify.js)
30. [D3 — Stratify docs (`d3.stratify`, `.path()`)](https://d3js.org/d3-hierarchy/stratify)
31. [d3-hierarchy — `src/hierarchy/index.js` (source; no visited set, no cycle detection)](https://github.com/d3/d3-hierarchy/blob/main/src/hierarchy/index.js)
32. [Graphviz — DOT language ("clusters form a strict hierarchy")](https://graphviz.org/doc/info/lang.html)
33. [d3-dag — documentation (`parentIds`; compound graphs explicitly unsupported)](https://erikbrinkman.github.io/d3-dag/)
34. [ELK — `org.eclipse.elk.hierarchyHandling` option reference](https://eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html)
35. [ELK — JSON graph format (nested `children`; hierarchy-crossing edges)](https://eclipse.dev/elk/documentation/tooldevelopers/graphdatastructure/jsonformat.html)
36. [Eclipse Public License 2.0 — official text](https://www.eclipse.org/legal/epl-2.0/)
37. [elkjs issue #312 — "Is the EPL-2.0 license compatible with GPLv3?"](https://github.com/kieler/elkjs/issues/312)
38. [Cytoscape.js — Compound nodes (`data.parent`, singular)](https://js.cytoscape.org/#notation/compound-nodes)
39. [Cytoscape.js issue #2220 — "Overlapping compound nodes" (multi-parent: unimplemented feature request)](https://github.com/cytoscape/cytoscape.js/issues/2220)
40. [React Flow — Sub-flows / nested nodes (`parentId`, `extent: 'parent'`)](https://reactflow.dev/learn/layouting/sub-flows)
41. [graphology-dag — npm (`hasCycle`, `willCreateCycle`, `topologicalSort`)](https://www.npmjs.com/package/graphology-dag)
42. [Demetrescu & Italiano — "Trade-offs for Fully Dynamic Transitive Closure on DAGs" (JACM)](https://www.diag.uniroma1.it/demetres/docs/jacm-tc.pdf)
43. [Incremental Reachability Index — LIPIcs / SEA 2025, Schloss Dagstuhl](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.SEA.2025.9)
44. [`hierarchy-closure` — Eric Prud'hommeaux (incremental transitive closure, multi-parent, append-only)](https://github.com/ericprud/hierarchy-closure)
45. [`dag-browser-widget` — Sigfried Gold (headless polyhierarchy DAG browser, **GPL-3.0**)](https://github.com/Sigfried/dag-browser-widget)
46. [`tag-hierarchy` — npm ("a hierarchy is a lossy projection of a flat tagged relation")](https://www.npmjs.com/package/tag-hierarchy)
47. [`jskos-tools` — GBV (SKOS-compatible JSON for Knowledge Organization Systems)](https://github.com/gbv/jskos-tools)
48. [TypeORM — Tree Entities (`@TreeParent` is singular in all four modes, including closure-table)](https://github.com/typeorm/typeorm/blob/master/docs/docs/entity/4-tree-entities.md)
49. [`sanity-plugin-taxonomy-manager` — SKOS-compliant taxonomies in Sanity Studio](https://github.com/andybywire/sanity-plugin-taxonomy-manager)
50. [Drupal — multi-parent taxonomy terms supported since 8.9, but a single `weight` breaks drag-and-drop](https://www.drupal.org/project/hierarchical_taxonomy_menu/issues/3375335)
51. [`@zag-js/vanilla` — npm (vanilla-JS adapter, first published 2026-01-02)](https://www.npmjs.com/package/@zag-js/vanilla)
52. [Zag.js — Cascade Select machine (Beta)](https://zagjs.com/components/react/cascade-select)
53. [Base UI — Combobox (`multiple`, Chips, Groups, custom `filter`)](https://base-ui.com/react/components/combobox)
54. [shadcn/ui — Base UI Combobox (`shadcn add base/combobox`)](https://ui.shadcn.com/docs/components/base/combobox)
55. [cmdk — GitHub (`pacocoursey/cmdk`, repo now transferred)](https://github.com/pacocoursey/cmdk)
56. [react-select issue #5907 — "Is this package still maintained?"](https://github.com/JedWatson/react-select/issues/5907)
57. [`@mui/base` — npm (DEPRECATED: "replaced by @base-ui/react")](https://www.npmjs.com/package/@mui/base)
58. [PrimeReact — GitHub (repository ARCHIVED)](https://github.com/primefaces/primereact)
59. [PrimeUI — "The Next Chapter" (v11+ moves to a commercial licence)](https://primeui.dev/nextchapter)
60. [`@rc-component/cascader` — npm (the live scope; `rc-cascader` is frozen)](https://www.npmjs.com/package/@rc-component/cascader)
61. [Ant Design — TreeSelect ("ensure the uniqueness of each value")](https://ant.design/components/tree-select)
62. [Zag.js — documentation home (state machines; React/Vue/Solid/Svelte/Preact/vanilla adapters)](https://zagjs.com/)
63. [Ark UI — GitHub (`chakra-ui/ark`; unstyled, 4 frameworks, built on Zag)](https://github.com/chakra-ui/ark)
64. [TanStack Virtual — GitHub (headless, framework-agnostic virtualization)](https://github.com/TanStack/virtual)
65. [TanStack Table — Expanding guide (`getSubRows`, `getExpandedRowModel`, `ExpandedState`)](https://tanstack.com/table/latest/docs/guide/expanding)
66. [alphagov/miller-columns-element — GitHub (**archived 2025-08-28**)](https://github.com/alphagov/miller-columns-element)
67. [dnd-kit — GitHub (v6 legacy frozen; "next" line pre-1.0)](https://github.com/clauderic/dnd-kit)
68. [atlassian/pragmatic-drag-and-drop — GitHub (Apache-2.0)](https://github.com/atlassian/pragmatic-drag-and-drop)
69. [shadcn/ui — Breadcrumb (`BreadcrumbEllipsis` + `DropdownMenu` composition)](https://ui.shadcn.com/docs/components/breadcrumb)
70. [npm registry API](https://registry.npmjs.org) and [npm downloads API](https://api.npmjs.org/downloads) — all release dates, licences, deprecation flags and weekly download counts in this report
