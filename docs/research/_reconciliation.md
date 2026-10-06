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
| **D25** | **Tombstones: `EdgeDelta.removedNodes` carries the full deleted node**, and every edge touching it must be removed in the same delta (`danglingEdge` otherwise). `invert` is exact: it restores tombstones, removes nodes the delta created, and restores changed node fields. | Removing nodes by id only (the delta stops being self-describing), or cascading edge removal inside `applyDelta` (the delta stops saying what it did). | §8.1; [#4](https://github.com/i2mint/zodal-groups/issues/4) |
| **D26** | **Per-family cardinality lives on the family's root node** (`Node.family = { maxPerItem }`), counts *branches* (values an item falls under), and is checked on the delta's end state. | A profile field keyed by node ids (profiles are reusable presets; families are run-time data), or a rule on each value edge. | §8.2; [#4](https://github.com/i2mint/zodal-groups/issues/4) |
| **D27** | **`inferProfile(space) → {profile, violations, evidence}`** picks the tightest fitting candidate by a partial order over the structural dials; equivalent profiles are told apart by evidence; nothing fitting ⇒ the loosest of the least-violated. | A scalar "strictness score" (the dials are not totally ordered), or returning a custom profile fitted to the data (that is `evidence.observed`, one call away). | §8.3; [#4](https://github.com/i2mint/zodal-groups/issues/4) |
| **D28** | **`GroupStore` = `load()` + `apply(delta, {expectedRevision?}) → Result<{revision, inverse, space?}>` + `getCapabilities()` (+ optional `subscribe`, `closureIds`)**, with the profile as code passed to the store, not persisted. Every adapter runs `groupStoreContract` from `@zodal/groups-core/testing`. | A CRUD-per-edge interface (bypasses the one write primitive, D7), or a store that throws on a violation (a refused drop is an ordinary outcome, D15). | §8.4; [#2](https://github.com/i2mint/zodal-groups/issues/2) |
| **D30** | **`EdgeKindDef.membership?: boolean`** says whether an edge of the kind is a membership (makes a group, counts as a parent, obeys the structural rules). Defaults to `!symmetric`; custom associative kinds declare `membership: false`. | Inferring it from `symmetric` alone (wrongly makes `cites`/`see_also` memberships) or from `transitive` (wrongly makes `instance_of` not one). | §8.7 |
| **D29** | **Group-ness is judged on the delta's end state, and a node that *becomes* a group is held to the group rules** for the memberships it already has. | Judging each edge in list order (undo of a group delete could fail by edge order), and never re-checking a new group's parents (`flatTags` broke in two steps). | §8.5 |
| **D31** | **`@zodal/groups-collection` runs every operation in one order — dry-run the rules, write records, write each store once with `expectedRevision`, update embedded caches — and returns an inverse split per item.** Per item, record and edges succeed together or are compensated; bulk keeps what succeeded; no history. | Edges first (the common failure, a record write, would then always need a compensating store write); one undo stack in the facade (the app's history owns undo, zgroups_05 §1.8); an all-or-nothing bulk (acture: partial stays applied). | §8.8; [#1](https://github.com/i2mint/zodal-groups/issues/1) |

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

## 8. Decisions after the research (issue-driven)

These came from building on the model, not from the five reports. Each cites the issue that raised it.

### 8.1 Tombstones (D25) — [#4](https://github.com/i2mint/zodal-groups/issues/4) item 1

`EdgeDelta` never removed nodes, so undoing a group delete (or the delete half of a merge, which [#1](https://github.com/i2mint/zodal-groups/issues/1)'s `mergeGroups` needs) brought back the edges but not the node's label or payload. Linear's archive-vs-delete is the product precedent; Command-not-Memento (D7) is the constraint: undo must still be `invert(delta)`, not a snapshot.

**Decision.** `EdgeDelta` gains `removedNodes?: Node[]` — the *full* node, a tombstone. `deleteNodeDelta(space, id)` builds the delta (every touching edge + the tombstone) and `deleteNode`, `Groups.destroy` use it. `applyDelta` applies node removals last and refuses (`danglingEdge`) a removal that would leave an edge pointing at nothing.

- **Full node, not an id.** The delta alone says what was lost: an event log, a change feed or a store can replay or undo it without the prior state. (`removed` stays `EdgeId[]`; `invert` already reads removed edges from the space, and changing that would break callers.)
- **No cascade.** If `applyDelta` silently removed a node's edges, the delta would no longer describe its own effect, and its inverse would have to be computed from a diff. Explicit is the price of an exact inverse.
- **`invert` became exact**, which tombstones made possible: it also removes nodes the delta *created* (by upsert or as an auto-created edge endpoint) and restores the previous fields of nodes it *changed*. For that, an upsert field set to `undefined` now clears the field — the same thing a JSON round-trip does — so "restore a field the delta added" is expressible. Observable change: undoing `g.add('a', 'g')` now leaves no stray `a` and `g` nodes.
- **`mergeDelta(space, from, into)` (PR review)** builds the merge [#1](https://github.com/i2mint/zodal-groups/issues/1)'s `mergeGroups` needs: re-point `from`'s memberships to `into` keeping kind/label/order/meta, skip ones `into` already has and the edge between the two, then tombstone `from`. One delta, so one exact undo; a merge that would close a cycle is refused with the path.
- **Stale undo is refused, never applied (PR review).** A tombstone must match the live node exactly (`staleTombstone` otherwise), so undoing an add after the auto-created group was relabelled no longer deletes it. A new `EdgeDelta.addedNodes` *creates* a node and is refused (`nodeExists`) if the id is live; `invert` turns tombstones into `addedNodes`, so undoing a delete after the node was re-created is refused instead of merging two versions. Likewise an added edge may not reuse a live edge id (`edgeIdExists`); to replace an edge, remove it in the same delta. Remaining gap: `removed` carries edge *ids* only, so an undo cannot tell an edge was replaced under the same id in between — edge ids are minted unique, and store-level `expectedRevision` (D28) catches it.
- Additive: every existing caller compiles; the `Violation['code']` union grew (`danglingEdge`, `maxPerFamily`), which is why groups-core went to 0.2.0.

### 8.2 Per-family cardinality (D26) — [#4](https://github.com/i2mint/zodal-groups/issues/4) item 2

A board over a tag family needs to know the family is exclusive (Linear: "only one label from a given label group"); profiles only had global caps (`maxGroupsPerItem`).

**Decision: on the node** — `Node.family?: { maxPerItem: number }` (`EXCLUSIVE` = `{ maxPerItem: 1 }`), enforced by `applyDelta` with a `maxPerFamily` violation that names the family, the item and the values.

- **Why not the profile (D14).** A profile is a *named, reusable restriction* — `filesystem` means the same thing in every app — and it never names particular nodes. Families are run-time data: a user creates "Status" and ticks "exclusive". Putting them in the profile would make the profile per-dataset and force recreating the space to add a family. D14's real requirement — the runtime validator is the SSOT — is kept: the same `applyDelta` enforces it, and `validateProfile` reports it on foreign data.
- **Why it does not break D5.** The field is on the unified `Node`, not on a `Group` type; any node may carry it and it simply has no effect while the node has no subgroups — group-ness stays a data fact. Same pattern as `Edge.order` meaning nothing under an unordered profile.
- **Why not on the value edges.** The rule is about the family as a whole ("at most N of these"); scattering it over N edges invites them to disagree.
- **What is counted: branches, not edges.** The family's *values* are its direct subgroups (through transitive kinds); an item counts a value when the value is among its ancestors (kind-aware closure, as everywhere). So `Done` + `Done/Archived` is one value — one board column — and passes, while an item reaching `Todo` and `Doing` through a polyhierarchical subgroup is two and is refused. That is exactly the guarantee a board needs: each item lands in at most N columns. Being *in the family root itself* is no value.
- **Checked on the end state**, after the structural checks, over only the items the delta could have moved (children of added edges, items below an added group edge, items below a node whose rule the delta sets). Setting a rule that existing items already break is refused, like any other write. `canAddTo` includes it, so a drop target can say why.

**Amendment (PR review).** The rule is validated on write: `maxPerItem` must be an integer ≥ 1 (`isFamilyRule`), else `invalidFamilyRule`. More generally, `applyDelta` and `parseSnapshot` now share one structural validator (`nodeProblem` / `edgeProblem`, violation `malformed`), so **anything a write accepts, a load reads back**. That includes `payload` and `meta`, which must be plain JSON data (`jsonProblem`): a BigInt (which made the fs store's write throw), a function, a symbol, NaN/±Infinity, a class instance such as Date or Map, or a cycle is `malformed`. Nothing in a delta can make `applyDelta` throw. Before, `maxPerItem: 1.5` was accepted and then bricked the fs store's manifest.

### 8.3 Profile inference (D27) — [#4](https://github.com/i2mint/zodal-groups/issues/4) item 6

Design rationale §6.3.6: "infer the tightest profile that validates a corpus of edges". polytag's profile seam calls it.

**Decision.** `inferProfile(space, { candidates? }) → { profile, violations, evidence }`:

- validate the space under every candidate (`validateProfile`, new: a whole-space re-validation);
- among those that fit, take the minimal elements of a **partial order** — A is at least as tight as B when every cap is ≤ (`null` = unbounded), every permission A grants B grants, and A's edge kinds ⊆ B's. The dials are not totally ordered (`filesystem` and `flatTags` are incomparable), so a scalar score would be arbitrary; among incomparable fits the one whose restrictions the data visibly *exercises* most wins (a cap it reaches exactly, a prohibition it has something to obey), so one tag per item with no nesting infers `flatTags` rather than `filesystem` (PR review: list order used to decide); then the earlier candidate; the others are reported as `evidence.alternatives`;
- profiles with identical dials (`flatTags`/`folksonomy`, `nestedTags`/`labels`, `polyhierarchy`/`thesaurus`) are told apart by evidence the dials cannot see: `folksonomy` when every edge has `meta.assertedBy`, `thesaurus` when a kind other than `contains` is used; else the earlier candidate, with the rest in `evidence.equivalent`;
- when nothing fits (a foreign cycle, a broken family rule), the fewest-violations candidate, **the loosest on a tie** — a failure every candidate shares says nothing about tightness;
- `evidence.observed` carries the measured dials (max parents per item/group, nesting depth, kinds in use…), so a caller wanting an exact-fit custom profile has it one `resolveProfile` away; `evidence.rejected` says why each non-fitting candidate failed (its first violation's message).

It costs one re-validation per candidate: an audit tool, not a hot path. One finding it surfaced: `taxonomy` (`groupsMayContainItems: false`) fits **no space with at least one edge**, because every finite DAG has childless leaves and a childless node is an item (a space of isolated nodes does fit). Recorded on #4 (item 4). **Resolved (PR review, round 2): `taxonomy` is deprecated, not redefined** — a redefinition ("leaves may be items") would silently change what existing callers get. It keeps its meaning for one minor version, warns once on `resolveProfile('taxonomy')`, is listed in `DEPRECATED_PROFILES`, and is no longer an `inferProfile` default candidate. A vocabulary is modelled as a separate space next to the memberships (#1's `spaces`).

Known limit: per-family rules are checked once the structure is sound (they depend on the end state, which is not well-defined while structural violations remain), so a space that breaks both a profile cap and a family rule reports the cap first.

### 8.4 The `GroupStore` contract (D28) — [#2](https://github.com/i2mint/zodal-groups/issues/2)

The skill's sketch is now real code in groups-core (`store.ts`): `load()`, `apply(delta) → Promise<Result<GroupSpace>>`, `getCapabilities()` (the D19 record), optional `subscribe` and optional `closureIds` (present iff `closure.read === 'native'`).

- **Shaped around the one write primitive (D7)**, so undo, change feeds and the contract all work in deltas. A violation resolves to `{ ok: false }` (D15: a refused drop is ordinary); only I/O failure rejects.
- **The profile is code, not data.** The store is constructed with one and validates writes with it; it does not persist it (the same edges under another profile are the same edges). Loads are *not* validated (D8); `validateProfile`/`inferProfile` report the shape of stored data.
- **Snapshots** (`toSnapshot`, `parseSnapshot`, `fromSnapshot`) are the persisted shape: flat `nodes[]` + `edges[]` + `revision` (D20), with structural checks on read.
- **A client-side store reports `closure: { read: 'client', maintainedOnInsert: true, maintainedOnDelete: 'exact' }`**: a read-time walk has no cache to go stale, so it is exact by construction.
- **Listeners are isolated** (try/catch per listener, `onListenerError`), the zodal-dials lesson.
- **The contract kit** (`@zodal/groups-core/testing`, `groupStoreContract`) copies `@zodal/store/testing`'s design: async factory, `make` per case, `skip` with reasons, `dispose`, framework-agnostic cases throwing `ContractViolation`. It checks index consistency, cycle refusal *with a path made of real edges*, all-or-nothing refusal, delta/tombstone/merge round-trips, family rules, concurrent applies, capability honesty, subscription, and (with `persistent: true`) reopening. groups-core's own tests prove it catches a store that skips validation, lies about native closure, or loses concurrent writes.
- **fs hardening (PR review)**: queue and rename keyed on the manifest's real path (a symlinked directory lost half of 40 concurrent writes; a symlinked manifest was replaced by a regular file); another process's write between read and rename is detected and returned as `conflict` rather than silently overwritten — **and since round 2, excluded**: detection alone left a ~270 µs median check-to-rename window that lost 53 of 600 writes from 4 processes in review, so every `apply` now holds an exclusive `<manifest>.lock` (pid + timestamp, stale locks broken safely, `ManifestLockError` on timeout) from read to rename, proven by a real 4-process test; unknown top-level fields preserved and a `migrations` map keyed by version; file mode kept; stale temp files of dead processes swept; directory fsynced after the rename.
- **Adapters**: `createMemoryGroupStore()` (groups-core, the default) and `@zodal/groups-store-fs` (a sidecar JSON manifest, §6.5; atomic temp-file + rename with fsync, saves serialized per manifest across instances, parent directory created, a corrupt manifest is a `ManifestError` and is never overwritten or read as empty). IndexedDB and Supabase follow when a consumer needs them.

**Amendment (PR review, before 0.2.0 ships): `apply` returns the inverse, not the space, and takes `expectedRevision`.** The first shape (`apply(delta) → Result<GroupSpace>`) left rollback to the caller, who computed `invert` from an earlier read, against the wrong state. Three concrete failures: (a) writer A adds `q3 ⊃ i1` (creating `q3`), writer B files `q3` under `plans`, A's record write fails and A's compensation is refused with `danglingEdge`, leaving record and edges disagreeing; (b) A's undo after B renamed a group overwrote B's rename; (c) a Supabase or IndexedDB store cannot return the whole space without reading every membership (D10). Now:

- `apply(delta, { expectedRevision? }) → Result<{ revision, inverse, space? }>`. The **inverse is computed inside the store's serialized section against the state it applied to**; `space` is optional.
- A stale `expectedRevision` is refused with a `conflict` violation (`expectedRevision`, `actualRevision`) and writes nothing — so a compensation or undo applied with the revision it came from can never clobber a newer write. (a) becomes a clean `conflict` the caller can act on (re-read, compensate minimally); (b) is refused.
- **Round 2:** `StoreApplyOptions` states up front that without options the last write wins. A `conflict` reports the revision the caller expected and the store's *current* revision (the fs store re-reads it rather than reporting the one it read before the other writer). Revisions restart when a backing is deleted and re-created, so every apply also returns an **`epoch`** — the backing's history id, minted at creation (the fs manifest stores it) — and `expectedEpoch` from another history is refused with `conflict`, even when the revision number happens to match.
- `commitDelta(space, delta, options, epoch)` in groups-core is that serialized-section logic for any store holding a space in memory; change notifications carry the `inverse` too.

**Amendment (PR review): a smaller, fully tested capability record; a stronger kit.**

- **`serverFacetCounts` and `disjunctiveFacetCounts` are removed** from `GroupStoreCapabilities` until a store has a method that serves them: a flag no method backs is a promise the kit cannot test. They come back together with an optional `facetCounts` method (and `membersOf`/`groupsOf` for incremental loading) when the first server-side adapter (Supabase) needs them. `closure` (backed by the optional `closureIds`) and `ordering` (backed by the `order` round-trip) stay.
- **`dispose?()`** on `GroupStore`; the kit disposes every store it opens.
- **`load()` must not hand out the store's own mutable state.** The memory store returns `readonlySpace(space)` — an O(1) Proxy view whose maps and index sets throw on mutation.
- **The kit (32 cases; round 2 added a case that catches inverses computed from a stale read: six concurrent writers file items under a new group, exactly one inverse may tombstone it, and replaying the inverses newest-first must restore the start) adds:** a diamond (`X ⊃ A ⊃ C`, `X ⊃ B ⊃ C`, remove `A ⊃ C`, `C` must stay inside `X` — the naive closure-table delete); foreign data through a new `ctx.seed` (a cyclic, profile-breaking snapshot written straight to the backing must load, D8); two edge kinds on one `(parent, child)` pair (D3 — catches a store keyed on the pair); two instances on one backing writing concurrently; and a mutation attempt through a loaded space.

### 8.5 Group-ness on the end state; becoming a group (D29)

Two holes in edge validation, found while making undo exact. (1) Edges were validated in list order, with group-ness as of that moment, so re-adding a deleted group's edges could pass or fail depending on whether its parent edges or its member edges came first. (2) A node that *becomes* a group (gets its first member) had its existing memberships checked only as an item's: under `flatTags`, tagging `holiday` with `travel` and then tagging a photo with `holiday` produced a tag inside a tag; under `labels`, an item in two labels could become a two-parent label.

**Decision.** Within a delta, whether an edge's child is a group is judged on the delta's end state (it is a group if the delta gives it a member). And when an edge makes its parent a group, the parent's existing memberships are checked against the group rules (`groupsMayContainGroups`, `maxParentsPerGroup`, `maxDepth`), reported once per node per delta.

**Amendment (PR review): both directions, and only membership counts.**

- **The mirror case.** A group that loses its last member *becomes an item*, and its memberships are then held to the item rules (`maxParentsPerItem`, `maxGroupsPerItem`, `groupsMayContainItems`, and family rules). Under `polyhierarchy` with `maxParentsPerItem: 1`, deleting the only member of a two-parent group is refused, naming the group — before, it succeeded and left a space `validateProfile` rejected. This follows from D5 (group-ness *is* having members), so an emptied group really is an item.
- **Only membership kinds make a group or a parent.** An associative kind (declared `symmetric`, i.e. `related`) is "see also", not "is in": it makes nobody a group, counts as nobody's parent, and skips the structural rules. The criterion is *not* "transitive", as first proposed in review: `instance_of` is non-transitive yet hierarchical (Z39.19's BTI), and a class with instances is a group. `isMembershipKind` and `membershipParentCount` are exported; `isGroup` uses them.
- **One cause, one violation.** When nesting is forbidden outright (`groupsMayContainGroups: false`), `maxDepth` is not reported for the same edge as well.
- **Cycles and disjointness are order-independent (PR review, round 2).** The cycle check walked only transitive kinds, so `a ⊃instance_of d` then `d ⊃is_a a` was accepted while the reverse order was refused — and removing the `instance_of` edge then blocked `undo()` forever. Every kind that is `transitive` *or* `acyclic` now belongs to one acyclic order (`isAcyclicKind`), in `findCycle`, `detectCycles` and so `validateProfile`. Likewise disjointness is checked both ways: either kind may declare it, and the two edges may point either way between the pair.
- **`Groups.undo()` pops only after the undo applies.** A refused undo used to drop its history entry, so the next undo silently skipped to an older one. **The way out (round 2):** the refused entry stays (no silent skip), `undoViolations()` says why the next undo would be refused, and `discardUndo()` drops the entry so the caller can move on; `undoDepth` reports the history size. With validation order-independent, a single writer's LIFO undo is never refused — `tests/properties.test.ts` checks that over random deltas (all built-in kinds, seven profiles, three seeds), together with apply∘invert = identity, invert∘invert = the original effect, every state reloading from JSON unchanged, and every state validating in either edge order. Run against the pre-fix cycle and disjointness checks, it fails.

### 8.7 Which kinds are memberships (D30) — PR review, round 2

D29's amendment made group-ness and parent counts depend on *membership* kinds, and defined membership as "not symmetric". That is right for every built-in (`related` is the one associative built-in) but wrong for asymmetric associative kinds a user declares — `cites`, `see_also`: under `flatTags`, `labels` or `filesystem` such a link was treated as nesting or as a second parent and refused, although it says nothing about containment.

**Decision.** Membership is declared, not inferred: `EdgeKindDef.membership?: boolean`. The built-ins state it explicitly (`contains`, `is_a`, `part_of`, `instance_of`: `true`; `related`: `false`). An undeclared flag defaults to `!symmetric`, which keeps every existing built-in-based profile's behaviour; **a custom associative kind must declare `membership: false`**. Neither `symmetric` nor `transitive` is the right proxy: `cites` is asymmetric yet associative, and `instance_of` is non-transitive yet a membership. Membership and acyclicity are independent: `isAcyclicKind` (transitive or acyclic) decides what the cycle check walks; `isMembershipKind` decides what makes a group.

### 8.6 Cost model of the write path (PR review)

Checking an added edge reads the *child's* parents (few), never the *group's* members (possibly millions): the duplicate and disjointness checks used to list the whole group per edge, which made tagging 20k items into one group take ~10 s; it is now linear (~50 ms, guarded by `tests/scale.test.ts`). What remains O(N) is that `applyDelta` copies the space's maps on every call, because it returns a new immutable space (D22's revision-keyed memoization depends on that). So a bulk change must be **one** delta; many single-edge calls are O(N²). A `GroupStore` over a large membership relation should keep it in its backend and apply deltas there, not through an in-memory `GroupSpace` (D10) — which is also why `GroupStore.apply` does not have to return the whole space (D28 amendment).

### 8.8 The collection facade (D31) — [#1](https://github.com/i2mint/zodal-groups/issues/1)

polytag (and any app with items and tags) needs one object that keeps item records (a `DataProvider`) and group spaces consistent; until now the only bridge was `scopeFilter`, which assumes a `groups` field nothing wrote. `@zodal/groups-collection` is that object. The shape came from the issue's revision: several named spaces over one item universe (zgroups_05 §8.3), per-item failure semantics, inverses instead of a history, and operations exported both declaratively and as acture-shaped commands.

**Decision.**

- **Two edge seams per space.** `{ embedded: '<field>' }` keeps a `string[]` of group ids on each record and *derives* the space from the records on load (works over every provider; `scope()` is `scopeFilter` over that field). A `GroupStore` keeps the edges (nesting, kinds, labels, order, group nodes, at scale). Record edges get a deterministic id derived from `(group, item)`, so an inverse stays valid across reloads; store edges get unique ids, so an undo never removes a newer edge under a reused id (the §8.1 gap).
- **The order, and why records go first.** (1) dry-run every space with `applyDelta` — profile caps, family rules (D26) and cycles are refused before anything is written; a violation owned by one item (its edge's child, its node) drops that item, any other refuses the operation; (2) record writes, per item; (3) one delta per store space with `expectedRevision`/`expectedEpoch` (D28), rebuilt from the operation's *intent* and re-validated after a `conflict`, a bounded number of times; (4) embedded caches. The common failure — a record write — then needs no compensation at all; compensation (delete a created record, re-create a deleted one, restore a field, invert an earlier space's part) is reserved for a store refusing what the dry run accepted, which only a concurrent writer can cause. When even the compensation fails, the failure is marked `inconsistent` with the half left over.
- **Bulk keeps what succeeded** (acture's transaction rule; Dexie `BulkError`): `{ ok, succeeded, failed: [{ id, code, reason, violations? }], inverse }`. A delete or merge whose member could not be rewritten keeps the group, holding that member, and re-running completes it. A rename by id that moved only some members has already created the new group (carrying the old one's fields), so re-running it is refused (`groupExists`) and the reason names the completion: `mergeGroups(from, to)`.
- **A store that throws is re-read before anyone is compensated (PR review).** A store may commit and then throw (the fs store releases its lock in a `finally` after the rename); compensating would then delete a record whose edges exist. The facade re-reads the store and counts the write as landed only on evidence that the change is its own — edges under ids the store did not have before (store ids are unique), or an edge or node whose content changed to exactly what it wrote (a move's rank, a label). Round 2 of the review found that weaker tests (an added id present, a removal visible, upserts ignored) reported a move, a label rename or a remove-only write as succeeded when another writer had committed and ours had not; without such evidence the item is failed and flagged `inconsistent`.
- **The inverse is split per item** (`items[].edges` per space, `shared` for group-level parts), so `revert` has the same per-item semantics as the operation, and is plain data for any history. A revert never overwrites a newer change, and refuses the item as a `conflict` instead: tombstones and creates are already guarded (D25); a restored node field is checked against `expect` (the node as the operation left it); **a re-added membership whose group was deleted since is refused** unless the inverse itself restores the group — an edge would otherwise re-create it implicitly, past the tombstone guard (PR review); and an embedded field must still hold what the operation left, for every group the revert touches (`fieldsAfter`; record-edge ids are derived from the record, so the edge set alone cannot tell a re-tag from the original). A store revert whose target already holds is a no-op success. An embedded field is restored verbatim (its order) while it still names the same groups.
- **Embedded spaces treat the record as the source of truth, one writer per record**: each record an operation rewrites is re-read first and the cache re-synced, the new field is computed from it (unknown entries kept, a renamed group takes the old one's place, or binary-sorted with `order: 'sorted'`), and it is read back after the write — a provider has no revision, so a concurrent write that replaced the field is detected and reported (`conflict`, `inconsistent`), never believed. An emptied bare group is tombstoned in the same delta, because a reload would not derive it. A group that is also a record, or that the code-declared vocabulary declares, cannot be deleted, merged away or re-id'd *as a group* in an embedded space (`unsupported`): its node is the record's, or it would reappear on load.
- **Ranks live on store edges.** In an ordered `GroupStore` space new members are ranked with `orderBetween` (appended, or placed with `position`), and `moveInGroup` re-ranks one edge under its own id, so its inverse is exact — and guarded: the inverse carries the edge as the move left it, and a revert over a later move or untag is a `conflict`. A merge ranks the moved members after the target's last (they would otherwise tie with its ranks); unranked members get ranks in place before anything is appended or moved among them; a tie in foreign data fails the item, never throws. An embedded field orders its ids per item, not per group, so it holds no ranks.
- **One writer per embedded record, stated plainly.** The read-back catches a write that replaced ours, but a third writer landing between our read and our `update` is overwritten: a `DataProvider` has no revision to write against.
- **No mirror field on store spaces (yet).** D10 recommends denormalizing direct memberships onto the items for `arrayContainsAny`; with a `GroupStore` that is a second write per item and a race window the dry run cannot see. Left for when a consumer needs provider-side filtering over a store space.

---

## REFERENCES

The five deep reports, each with its own Vancouver-style reference section:

1. [`zgroups_01-classification-theory-and-polyhierarchy.md`](zgroups_01-classification-theory-and-polyhierarchy.md) — Z39.19, ISO 25964, SKOS, OWL, MeSH, GO, Wikipedia categories; the invariants; hierarchical tagging in the wild; constraint-profile prior art. *40 refs.*
2. [`zgroups_02-storage-indexing-and-query.md`](zgroups_02-storage-indexing-and-query.md) — adjacency list / materialized path / nested set / closure table / edge table; write-time vs read-time closure; faceted-search internals; per-backend mapping. *51 refs.*
3. [`zgroups_03-navigation-and-ux-patterns.md`](zgroups_03-navigation-and-ux-patterns.md) — the navigation catalog; what changes under polyhierarchy; search × hierarchy; ARIA & virtualization. *58 refs.*
4. [`zgroups_04-js-ts-library-landscape.md`](zgroups_04-js-ts-library-landscape.md) — every UI surface, with status lines and a consolidated decision table. *70 refs.*
5. [`zgroups_05-design-patterns-and-architecture.md`](zgroups_05-design-patterns-and-architecture.md) — Composite under a DAG; canonical relation vs projections; Datomic/Git/VFS/Zanzibar; Zod recursion pitfalls; the type sketch. *45 refs.*
