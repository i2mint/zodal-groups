# Reconciliation — the merged decisions

*This is the SSOT for "what did we decide and why." It merges the five research reports
(`zgroups_01`–`zgroups_05`), resolves the places where they disagree, and closes the open
decisions each of them flagged. Where a report is superseded here, this document wins.*

**Read this before writing any `zodal-groups` code.** The deep reports are the *why*; this is
the *what*.

---

## 0. The thesis (confirmed)

> **Membership is the canonical data — a flat set of edges. Every folder tree, tag cloud, facet
> browser, and breadcrumb is a computed *projection* over those edges. The "an item lives in
> exactly one place" limitation was never in the data; it is a property of one projection.**

The thesis survived contact with every system the research examined. Two pieces of evidence are
decisive enough to state up front:

1. **POSIX filesystems already violate "one place."** A file may be hard-linked into many
   directories. What Unix forbids is hard links *to directories* — solely to keep the directory
   graph acyclic so refcount GC terminates [05§6, 01§0]. The real Unix rule is not "one parent";
   it is a **constraint profile**: `maxParentsPerItem = ∞, maxParentsPerGroup = 1`.
2. **Zotero ships the thesis as a checkbox.** `View → Show Items from Subcollections` re-renders
   the *same edges* as strict-containment or closure-expanded [01§5.2]. The hierarchy is
   literally a view flag.

And one decisive counter-signal, which we must respect rather than dismiss:

3. **Google Drive abolished multi-parenting** (2020-09-30): "it is no longer possible to place an
   item in multiple folders." Extra parents were migrated to **shortcuts** [03§B]. This is *not*
   evidence against the model — it is evidence about **presentation**: a tree of visible shortcut
   nodes was judged teachable where a DAG of items was not. Hearst says the same thing directly:
   don't teach polyhierarchy through a folder metaphor, because "users would be unfamiliar with
   the idea of an item simultaneously residing in multiple folders" [03§A].
   → **Consequence (binding): the DAG is the model; the default *projection* must always be
   something a user already understands.** We ship the honesty in the model and the familiarity
   in the view. See D12.

---

## 1. The decision table

The money summary. Each row is a decision, the reports that back it, and the alternative we
rejected.

| # | Decision | Rejected alternative | Source |
|---|---|---|---|
| **D1** | **One canonical relation: a set of reified edges `{id, parent, child, kind, label?, order?, meta?}`.** Nothing else is authoritative. | Two structures (a "folders tree" + a "tags map") synced by Observer — that *is* index drift, waiting. | 05-K1/A6, 01-K2 |
| **D2** | **Forward and inverse are two *indexes*, not two structures** — one writer, one transaction. This is the answer to the user's `groups_to_tags`/`tags_to_groups` "live view" problem. | Snapshot conversion functions. | 05-K2; Datomic AVET/VAET; Boost.Bimap |
| **D3** | **The edge is reified and carries `kind`.** Closure semantics are a property **of the edge kind**, not of the system. | An unreified `Set<[item, group]>` — cannot express folksonomy, provenance, order, or per-kind transitivity. | 01-D4/K3 |
| **D4** | **Names and order live on the EDGE, not the node** (Unix dentry / Git tree-entry). | `node.name` — makes "same item in two groups under two names" unrepresentable. | 05-K3 |
| **D5** | **Unified node type.** An item and a group are the same kind of thing; "group-ness" is *having children*, not a type. Bipartite-ness is a **profile predicate**, not a type distinction. | Distinct `Item`/`Group` types — cannot express "filesystem" without reintroducing a union, and forecloses Are.na's channel-as-block. | 05-K4/A4, 01-D5 |
| **D6** | **Brand `NodeId` only. Never `ItemId` vs `GroupId`.** | Branded item/group ids — an item may *be* a group; group-ness is a data fact, not a static one. | 05-A4 |
| **D7** | **`EdgeDelta { added, removed }` is the ONLY write primitive.** Undo = `invert(delta)` (Command, not Memento). Event-sourced adapters and change-feeds come free. | Ad-hoc mutation methods. | 05-K8 |
| **D8** | **Acyclicity is an enforced invariant on write** — but **every projection must still be cycle-safe on read**. See §2.1: this is a real reconciliation, not a contradiction. | Either "allow cycles because it's a graph" (kills closure, refcounting, termination) or "assume the data is acyclic" (imports and foreign adapters *will* hand us cycles). | 05-K5/A10 vs 03§B.3, 01§4.1 |
| **D9** | **Closure is read-time by default; a closure table is a *cache*, never truth.** | Write-time item-level closure (the Algolia `lvl0/lvl1/lvl2` encoding) — see §2.2. | 01-K5, 02 |
| **D10** | **Materialize the closure of the *group DAG only* — never of the items.** The two graphs have wildly different sizes; this is the finding that makes the whole design work. See §2.2. | Materializing item closure (update storm) or nothing (slow reads). | 02 (headline) |
| **D11** | **Never materialized-path, never nested-set, as the canonical encoding.** Both are structurally incapable of multi-parent. Fine as *adapter-level* encodings behind a capability flag. | See §2.3 — nested set is eliminated twice over. | 02, 05-A7 |
| **D12** | **The universal projection output is a flat, ordered `PathNode[]`** — `{nodeId, pathKey, path, depth, isRecursive, …}`. One structure serves tree view, treegrid, virtualization, ARIA, icicle, and Miller columns. | Emitting a nested node tree. | 03§B.3/D.2 (load-bearing) |
| **D13** | **Expansion state is keyed by `pathKey`; selection state is keyed by `nodeId`.** Not a compromise — expansion is a *view* fact ("I opened this drawer", and there really are two drawers); selection is a *model* fact ("I chose this thing", and there is one thing). | Keying both by `nodeId` (ships spontaneous off-screen expansions) or both by `pathKey` (ships dead selection highlights). | 03§B.3 |
| **D14** | **Profiles: one model, named restrictions, each buying a guarantee** (steal OWL 2 Profiles' framing + SHACL's report shape). Runtime validator is the SSOT; type-level narrowing is a bonus on top. | Type-level-only constraints — data arrives from adapters that don't know the profile, so the validator must exist anyway. | 01-D3/§7 |
| **D15** | **Cycles are reported with the offending path**, not a boolean. `canAddChild()` returns *why*. In a DAG the cycle can close through an off-screen branch, so **the user cannot see why a drop is illegal** — without the sentence, correct cycle prevention is indistinguishable from a bug. | `boolean` return. | 03§B (flagged as a top-3 UX risk) |
| **D16** | **Drag-and-drop default is ADD-a-parent; MOVE requires a modifier.** Inverts Finder deliberately: MOVE destroys an edge the user often cannot see, and is *undefined* when dragging out of a search result. Gmail's two-verb split (`Label` vs `Move to`) is the precedent. | Finder's default (drag = move). | 03§B (flagged as the most dangerous interaction) |
| **D17** | **Counts are a de-duplicated union over the transitive closure — never `Σ children.count`.** Solr's documented default double-counts multivalued docs. Under polyhierarchy the naive rollup is *wrong*, not *broken* — which is worse. | Summing child counts. | 03§B, 02 |
| **D18** | **`Member<V> = ref | value` with a pluggable `IdentityStrategy`** (extrinsic id for entities; **content hash** for literals — Git's trick, so `hash('cheese') = 'cheese'`). The edge table stays uniform (always `NodeId`), so no algorithm ever branches. | Forcing everything through a ref (silly for `'cheese'`) or through a value (breaks large documents). | 05-K9; answers the user's literal-vs-reference question directly |
| **D19** | **Honest closure capability is a record, not a boolean**: `{read, maintainedOnInsert, maintainedOnDelete: 'exact'|'rebuild'|'unsupported'}`. | `supportsClosure: boolean` — meaningless without saying what happens on delete (the `path_count`/DRed problem). | 05-K10/A8 |
| **D20** | **Do NOT model the graph as a recursive Zod schema.** Validate flat `nodes[]` + `edges[]`; enforce structure with `validateProfile()`. | `z.lazy` — Zod docs: "passing cyclical data into Zod will cause an infinite loop"; recursive inference "is finicky"; TS 5.9+ breaks it (`TS2615`). | 05-A3 |
| **D21** | **Intensional ("smart") groups are first-class objects** — nameable, nestable, taggable — even though their *extent* is derived. Extensional vs intensional = Datalog's EDB/IDB. **Leaf-only in v1**; do not build a Datalog engine. | Full recursive intensional groups (a research project, not a feature). | 01-D2/K12-13, 05-K11 |
| **D22** | **No reactivity library in the core.** Pure projections + a `revision` stamp + a change stream; let any host (Reselect / MobX / signals / Zustand) memoize on `revision`. | Depending on MobX/Jotai/signals in core — violates headless-first. | 05-K7/A9 |
| **D23** | **Composite is rejected as the canonical model, accepted as the output type of `projectTree()`.** | Composite as the model — its GoF intent literally says *tree*; under a DAG the `parent` pointer is ill-typed, recursion double-counts, and path ≠ identity. | 05-A1/K12 |
| **D24** | **Do not call this CQRS.** It is one relation with two synchronous indexes. CQRS's defining property is *eventual* consistency; ours is synchronous. | The CQRS label (and Fowler's own warning attached to it). | 05-A5 |

---

## 2. Where the reports disagreed, and how it resolves

### 2.1 Cycles: forbidden or inevitable?

- **05** says: never allow cycles (A10). They kill refcounting, termination, and closure.
- **03** says: real taxonomies *do* contain cycles. Perugini's ODP study found symbolic links "by
  inducing cycles, preclude the underlying graph model from being a DAG." Wikipedia's category
  graph has them.
- **01** says: acyclicity is the precondition for well-defined closure.

**Resolution — both, at different layers, and this is load-bearing:**

- **Write path: acyclicity is an enforced invariant.** `applyDelta` rejects any delta that would
  close a cycle, and reports the offending path (D15). There is no `allowCycles` flag.
- **Read path: every projection is nevertheless cycle-*safe*.** `PathNode.isRecursive` is **not
  optional**. Projections must terminate on adversarial input.

This is not belt-and-braces. It follows from a fact about our architecture: **`zodal-groups` does
not own its data.** Edges arrive from store adapters, imports, and other systems that never heard
of our invariant. A projection that assumes acyclicity is a projection that hangs the browser on
someone else's bad data. Enforce on write; never *trust* on read.

*(If a user genuinely needs cyclic structure, they need a graph library — `zodal-graphs` — not
this one.)*

### 2.2 Closure: write-time or read-time? — the false dichotomy

The brief posed this as (a) materialize on write vs. (b) expand on read. **Report 02's headline
finding is that this is a false dichotomy, because there are two graphs, not one, and every prior
treatment conflates them:**

| | the **group DAG** | the **membership relation** |
|---|---|---|
| what it is | group→group edges (the taxonomy) | item→group edges |
| size | **tiny** — hundreds to low tens of thousands of nodes | **huge** — millions of rows |
| change rate | rare (an admin re-parents a folder) | constant |

**The decision (D9 + D10): materialize the closure of the *group DAG only*.**

- Edge table is the source of truth → re-parenting is **O(1)**.
- A derived `group_closure` (≈ *n* × depth rows) is rebuildable **in-transaction, in
  milliseconds**, because the group DAG is tiny. → **The `path_count`/DRed deletion problem
  (05-A8) simply evaporates: we rebuild rather than incrementally maintain.**
- Direct memberships are denormalized onto items as an indexed **set** (GIN / `multiEntry`).
- A read is: expand group → descendant set → `arrayContainsAny([...descendants])`.

This buys write-time's single-probe reads *and* read-time's O(1) writes, and — the thing that
matters most — **no item row is ever touched when the taxonomy changes.** The update storm is
structurally absent.

**It also means we need no new filter operator.** `arrayContainsAny` already exists in
`@zodal/core` and maps to Postgres `&&` → PostgREST `ov` → Dexie `anyOf`. This is a significant
simplification versus the "add a `descendantOf` operator" plan we started with.

> **Superseded:** my initial reading (and the `zodal` `FilterOperator` gap analysis) called for a
> new transitive operator in `@zodal/core`. **Not needed.** Closure expansion happens in
> `groups-core`; the resulting id set goes through the existing `arrayContainsAny`.

### 2.3 Nested set — eliminated, and worth documenting so nobody re-litigates it

Not merely slow: **structurally incapable of multi-parent.** It encodes containment in a *linear
order*, so one interval = one position = one parent. Report 02 flags the trap: it is the encoding
most likely to surface from a naive search, **because it optimizes the one metric everyone
benchmarks first** (subtree read).

Materialized path / `ltree` fails **combinatorially, not linearly**: forcing multi-parent means
storing a *path set* per node, and distinct root-paths in a DAG are exponential in depth (a
diamond chain gives 2^d). Adding one edge high in the DAG multiplies every descendant's path
count. (Postgres's `ltree[]` GiST opclass is also explicitly **lossy**.)

### 2.4 Edge kinds — the refinement that changes the model

**01's biggest finding, and it overrides the naive version of the thesis:** membership edges alone
are **not sufficient**. You need the edge's *kind*.

SKOS deliberately makes `skos:broader` **non-transitive**, because mixed-kind chains produce false
inferences: *wheel* is `part_of` a *car*, a *car* is `is_a` *vehicle* — but a wheel is **not** a
vehicle. The Gene Ontology only earns transitivity by declaring composition rules
(`is_a ∘ part_of → part_of`) and *excluding* unsafe relations. Z39.19 gates BT/NT behind an
"all-and-some" test.

→ **`poodle ⟹ dog ⟹ animal` is not answerable from the edge set alone.** It is answerable from
the edge set *plus declared closure semantics per edge kind*. So `EdgeKindDef` carries
`{transitive, symmetric, acyclic, composesWith, disjointWith}`, and the default kind
(`contains`) is transitive — but `related` is not.

Most tagging libraries forget this. It is the difference between a toy and a thesaurus.

### 2.5 Paths stop being identifiers

Once membership is canonical, **a path is a *route*, not an identity** (01-Refinement B). Anything
that needs a stable identifier — a URL, a deep link, a breadcrumb — needs an explicit
`primaryParent`, plus `allPaths()` with a hard cap. MeSH is the cautionary tale: because its
parent edges live between *tree-number positions*, its descriptor-level `broaderDescriptor`
shortcut **disagrees with the tree walk** — and their own docs warn about it.

---

## 3. The constraint profiles

The user's requirement — *"seamlessly cover pure hierarchies, flat tagging, nested groups, and
hybrids"* — is met by making every use case a **profile** over one model. Nobody else ships this;
report 01 calls it the whitespace `zodal-groups` occupies.

```ts
interface GroupProfile {
  // structural
  maxParentsPerItem:   number | null;  // 1 ⇒ classic folders
  maxParentsPerGroup:  number | null;  // 1 ⇒ the group graph is a forest
  maxDepth:            number | null;  // 0 ⇒ flat tagging
  maxGroupsPerItem:    number | null;  // "how many tags may an item carry"
  groupsMayContainGroups: boolean;     // false ⇒ flat tag namespace
  groupsMayContainItems:  boolean;     // false ⇒ pure classification skeleton
  groupsAreItems:      boolean;        // true  ⇒ Are.na channel-as-block
  ordered:             boolean;
  // semantic
  edgeKinds: Record<string, EdgeKindDef>;
}
```

| profile | expansion | covers |
|---|---|---|
| `filesystem` | `maxParentsPerItem: 1, maxParentsPerGroup: 1` | folders & subfolders |
| `flatTags` | `maxDepth: 0, groupsMayContainGroups: false` | tagging, no tagging-of-tags |
| `nestedTags` | `maxParentsPerGroup: 1, groupsMayContainGroups: true` | Obsidian/Bear — *but with real edges* |
| `labels` | `maxParentsPerItem: null, maxParentsPerGroup: 1` | **Gmail**: items multi-parent, label tree is a tree |
| `polyhierarchy` | all defaults, acyclic | the general case |
| `thesaurus` | `polyhierarchy` + typed `edgeKinds` + `related` + aliases | Z39.19 / SKOS |
| `folksonomy` | `flatTags` + per-user membership edges | the `(tag, object, identity)` triple |

Note the ladder is Z39.19's own (list → synonym ring → taxonomy → thesaurus), from 2005. We did
not invent it; we typed it.

---

## 4. What the UI layer must be told (and what it must never be told)

- **The gesture is not in the model.** A `GroupsView` descriptor says *what* the groups are, never
  whether they open in a panel or expand in place. (`zodal-dials` already proved this pattern.)
- **`PathNode[]`, always** (D12). Virtualization and polyhierarchy want the *exact same*
  structure, which is why this one decision pays for itself three times.
- **ARIA forces our hand, and it agrees with us.** `aria-owns` explicitly forbids multiple owners:
  *"Do not specify the id of an element in more than one other element's `aria-owns`."* **The
  accessibility tree *is* a tree.** So the DAG must be unfolded into path-nodes *before* it reaches
  the DOM — and then `aria-level = pathNode.depth` is unambiguous, because the path is what got
  you here. Multi-parenthood is conveyed **semantically** (*"Reading, tree item, level 3, also in
  2 other groups"*), never structurally. This is not a workaround; it is the correct reading of
  the spec.
- **DOM key / React key = `pathKey`, never `nodeId`.** Duplicate DOM ids are invalid HTML and will
  silently corrupt `aria-owns`, `aria-activedescendant`, and label associations. *This is the
  concrete bug a `nodeId`-keyed tree ships with.*
- **"What other groups is this item in?"** is a first-class affordance (`otherLocations()`),
  meaningless in a tree and essential here. Are.na's *"This channel appears in"* is the reference.
- **Remove ≠ delete**, universally, and every serious product distinguishes them. Ship an explicit
  orphan view (Zotero's **Unfiled Items**) rather than an implicit universal group.

**The default projection must not be the tree.** Report 03's decision table is blunt: **Miller
columns, drill-down, faceted browsing and search-first survive polyhierarchy natively** (the
column stack *is* the path — and Mark Miller himself generalized the technique to directed
graphs), while **the tree view survives it least well and costs the most to get right.**

---

## 5. Library decisions (from 04)

**The finding that governs the UI architecture** — verified by reading source, not docs: *every*
tree library keys UI state by **node id**, so a node under two parents expands in both. But the
libraries that let you **supply node identity** (`headless-tree`'s `getChildren(itemId)`, Zag's
`nodeToValue`, TanStack's `getRowId`, Downshift's `itemToKey`) become **fully DAG-capable if you
feed them synthetic path ids.**

→ **So `groups-core` must own the path-keyed, lazily-unfolded projection. No library computes it;
every library can render it.** That is precisely `PathNode[]` (D12), and it is why the same
decision keeps paying.

| surface | primary | notes |
|---|---|---|
| headless tree state | **own it** (`PathNode[]`) + adapt into headless-tree / Zag / TanStack | no library does DAG unfolding |
| virtualization | **TanStack Virtual** | flatten-to-visible-rows = `PathNode[]` |
| drag & drop | **pragmatic-drag-and-drop** | its `Instruction`/`Operation` model *is* our config-object model; Alt+drop = add-a-parent falls out free |
| Miller columns | **build it ourselves** | the category is a graveyard — and it's the best DAG view, precisely because it's path-oriented |
| facets | own the refinement state; **Algolia's `lvl0/lvl1/lvl2`** is the only native multi-parent facet encoding, but `hierarchicalMenu` is single-select |
| space-filling viz | **d3-hierarchy** as pure math | ⚠️ **no correct space-filling treemap of a DAG exists** — project to `PathNode[]` (an icicle falls out: depth→x, index→y) |
| containment graph | **ELK** | ⚠️ EPL-2.0, 423 kB — optional peer dep |

**Third renderer: Ark UI / Zag.js.** `@zag-js/vanilla` now exists, so **one state machine backs
React *and* vanilla *and* Vue/Svelte/Solid** — it is renderer #3 through #7. That is a strictly
better answer than adding a second React-only widget library.

**Prior art: proven absent.** npm's entire inventory for "polyhierarchy" is one two-week-old GPL
widget with 9 downloads/week; its inventory for "transitive closure" is *the Google Closure
Compiler*. Every tree builder, every ORM tree plugin, and every graph renderer's containment model
is strictly single-parent.

**Dead or trapped — do not adopt:** dnd-kit v6 (16M downloads/wk but frozen since Dec 2024 — the
download figure is a trap), cmdk (no release in 16 months), react-select (488 open issues),
react-dnd (dead since 2022 — and `react-arborist` still pins it), PrimeReact (archived; v11+ is
paid), `@mui/base` (deprecated), MUI X tree DnD (behind a paid Pro licence), Orama's disjunctive
facet counts (broken), Observable Plot (has no treemap mark at all).

---

## 6. Sharp edges — the things that will bite

1. **Disjunctive facet counts require N+1 queries** (one per selected facet, with that facet's own
   filter removed). Meilisearch, Solr `excludeTags`, and Algolia all confirm. **It is
   architectural, not a flag** — so it belongs in `ProviderCapabilities`, not discovered later.
2. **Ordering must live on the edge.** An item in three groups needs three ranks. Use **fractional
   indexing** (a plain sortable string, so `sort` works on every adapter with zero new
   capabilities) — but note the sharp edge: `localeCompare` and locale-aware DB collations
   **silently corrupt** base-62 key order. Needs binary / `C` collation.
3. **Within-facet is OR; across-facets is AND** ("a conjunct of disjuncts", Hearst). Everyone gets
   this wrong once.
4. **PostgREST cannot express a recursive CTE or a subquery at all** — Supabase needs an **RPC**.
   (POST also dodges the URL-length limit that would kill wide read-time expansion.)
5. **Filesystem adapter: keep the DAG in a sidecar manifest, not in symlinks.** Hard links to
   directories are forbidden; symlinks make cycles *your* bug.
6. **S3: `CommonPrefixes` is a browsing affordance, not an index.** Needs explicit inverted-index
   objects.

---

## 7. Open questions deliberately deferred

- **Live/reactive intensional groups** (BeOS live queries, Spotlight smart folders auto-updating).
  We ship intensional groups as leaf-only and re-evaluated on read. Live invalidation is post-v1.
- **Per-user membership edges (folksonomy) at scale** — the model supports it (reified edge with
  an `assertedBy`), but no adapter optimizes for it yet.
- **Cross-collection grouping** (an item from collection A and one from collection B in the same
  group). The `NodeId` model permits it; no adapter implements it.

---

## REFERENCES

The five deep reports, each with its own Vancouver-style reference section:

1. [`zgroups_01-classification-theory-and-polyhierarchy.md`](zgroups_01-classification-theory-and-polyhierarchy.md) — Z39.19, ISO 25964, SKOS, OWL, MeSH, GO, Wikipedia categories; the invariants; hierarchical tagging in the wild; constraint-profile prior art. *40 refs.*
2. [`zgroups_02-storage-indexing-and-query.md`](zgroups_02-storage-indexing-and-query.md) — adjacency list / materialized path / nested set / closure table / edge table; write-time vs read-time closure; faceted-search internals; per-backend mapping. *51 refs.*
3. [`zgroups_03-navigation-and-ux-patterns.md`](zgroups_03-navigation-and-ux-patterns.md) — the navigation catalog; what changes under polyhierarchy; search × hierarchy; ARIA & virtualization. *58 refs.*
4. [`zgroups_04-js-ts-library-landscape.md`](zgroups_04-js-ts-library-landscape.md) — every UI surface, with status lines and a consolidated decision table. *70 refs.*
5. [`zgroups_05-design-patterns-and-architecture.md`](zgroups_05-design-patterns-and-architecture.md) — Composite under a DAG; canonical relation vs projections; Datomic/Git/VFS/Zanzibar; Zod recursion pitfalls; the type sketch. *45 refs.*
