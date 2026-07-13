# zodal-groups research corpus

Five deep-research reports (~3,900 lines, ~264 cited sources) on hierarchical and
**poly**hierarchical grouping — the problem of organizing items like folders do, without the
"an item lives in exactly one place" limitation.

> **If you read only one thing: [`_reconciliation.md`](_reconciliation.md)** — the merged decision
> table (24 decisions), the places the reports disagreed and how it resolves, the constraint
> profiles, and the library picks. It is the SSOT. Come back here for the *deep* doc behind any
> single decision.

## The reports

| # | Report | What it settles | Read it when |
|---|---|---|---|
| 01 | [Classification theory & polyhierarchy](zgroups_01-classification-theory-and-polyhierarchy.md) | The vocabulary (facet / taxonomy / thesaurus / folksonomy — and what practitioners get wrong). Z39.19, ISO 25964, SKOS, OWL, MeSH, Gene Ontology, Wikipedia categories. The invariants: cycles, the diamond problem, transitive inheritance. Hierarchical tagging in the wild (path-as-string vs. real edges). The constraint-profile vocabulary. | You're naming a concept, deciding closure semantics, or defining a profile. **The `edgeKinds` finding lives here** — and it changes the model. |
| 02 | [Storage, indexing & query](zgroups_02-storage-indexing-and-query.md) | Adjacency list vs. materialized path vs. nested set vs. closure table vs. edge table, with an explicit **multi-parent** and **dynamic-re-parenting** row. Write-time vs. read-time closure. Faceted-search internals (Solr / Lucene / Algolia / Meilisearch). Per-backend mapping (Postgres, PostgREST, fs, S3, Dexie). Fractional indexing. | You're writing a store adapter, choosing an encoding, or wondering why the "obvious" nested-set answer is wrong. **The two-graphs insight lives here.** |
| 03 | [Navigation & UX patterns](zgroups_03-navigation-and-ux-patterns.md) | The catalog of navigation designs with standard terminology (tree, Miller columns, drill-down, breadcrumbs, faceted browsing, treemap/icicle, search-first). **What changes when it's not a tree.** Search × hierarchy. ARIA and virtualization. | You're building any UI surface, or deciding what the default view should be. **`PathNode[]` and the expansion/selection keying rule live here.** |
| 04 | [JS/TS library landscape](zgroups_04-js-ts-library-landscape.md) | Every UI surface we need, with status lines (licence, last release, maintenance, headless?) and a consolidated decision table. What's dead, what's a trap, what's paid. | You're about to add a dependency. Check here first — several popular picks are frozen or licence-trapped. |
| 05 | [Design patterns & architecture](zgroups_05-design-patterns-and-architecture.md) | Composite under a DAG (spoiler: it's a trap). Canonical relation vs. projections. Datomic, Git, Unix VFS, Zanzibar as reference models. The bidirectional-mapping problem. Zod-v4 recursion pitfalls. The TS type sketch. | You're writing core model code, or tempted by a famous pattern. **The `EdgeDelta` / unified-node / names-on-the-edge decisions live here.** |

## The five findings that most changed the design

1. **There are two graphs, not one** (02). The *group DAG* is tiny; the *membership relation* is
   huge. Every prior treatment conflates them. Separate them and "write-time vs. read-time closure"
   becomes a false dichotomy: materialize the closure of the **group DAG only**, and the update
   storm is structurally absent.
2. **Edge *kind* is not optional** (01). SKOS makes `broader` non-transitive on purpose: *wheel*
   `part_of` *car* `is_a` *vehicle* does **not** make a wheel a vehicle. `poodle ⟹ animal` is not
   answerable from edges alone — only from edges *plus* declared per-kind closure semantics.
3. **`PathNode[]` is the universal projection output** (03). One flat structure serves tree view,
   treegrid, virtualization, ARIA, icicle, *and* Miller columns. And it resolves the classic
   tree-state bug exactly: **expansion keyed by `pathKey`, selection keyed by `nodeId`.**
4. **Composite is a trap** (05). Its GoF intent literally says *tree*. Under a DAG the `parent`
   pointer is ill-typed, recursion double-counts, and path ≠ identity. Keep it — but only as the
   *output* of `projectTree()`, where it finally fits.
5. **No library computes a path-keyed DAG unfolding; every library can render one** (04). That gap
   is precisely what the core must own, and it is why decision D12 keeps paying for itself.

## Two things worth knowing before you argue with the design

- **Google Drive abolished multi-parenting in 2020** and migrated extra parents to *shortcuts*.
  That is not evidence against the model — it is evidence about **presentation**. Same information,
  different projection. It is why the default view must never be a naked DAG.
- **Nobody ships a grouping library parameterized by constraints.** The pieces all exist (SHACL can
  express it, Z39.19 describes the ladder, OWL 2 establishes the "profile" framing), but there is
  no TS/Zod-native, projection-aware implementation. npm's entire inventory for "polyhierarchy" is
  one GPL widget with 9 downloads/week. **That is the whitespace `zodal-groups` occupies.**
