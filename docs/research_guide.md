# Research Guide — when to read what

**Purpose.** A *routing index* for the zodal-groups design corpus. It tells you **which document to
open for a given task** — and which to skip — so you never read 3,900 lines to make one decision.

> **If you read only one thing:** [`docs/research/_reconciliation.md`](research/_reconciliation.md)
> — the merged decision table (D1–D24), the conflicts and how they resolved, the profiles, and the
> library picks. It is the SSOT and it *supersedes* the individual reports wherever they disagree.

## How the corpus is organized

Three layers:

1. **Design intent** (`docs/*.md`) — what zodal-groups *is*. Stable; rarely changes.
2. **Research reports** (`docs/research/zgroups_0N-*.md`) — five deep surveys, ~264 cited sources,
   Vancouver-style. Consulted per-topic when building.
3. **Consolidation** (`docs/research/_reconciliation.md`, `docs/research/README.md`) — the merged
   decisions. **The SSOT for "what did we decide and why."**

## Tier 1 — orient (read once)

| Doc | Settles | Read when |
|---|---|---|
| [`zodal-groups-concept.md`](zodal-groups-concept.md) | The thesis: *membership is canonical; every tree is a projection.* The three layers (Model → Affordances → Targets). The profile table. | You need the *why* / the elevator pitch, or you're deciding whether something belongs in the model or in a target. |
| [`research/_reconciliation.md`](research/_reconciliation.md) | **24 numbered decisions**, the reports' conflicts and their resolution, the constraint profiles, library picks, and the sharp edges. | **Before writing any code.** Cite decisions by number (D9, D13…) in PRs and commits. |
| [`research/README.md`](research/README.md) | The five-report index + the five findings that most changed the design. | You want to know which report owns a topic. |

## Tier 2 — the deep reports (consult per-topic)

| Report | Owns | Open it when |
|---|---|---|
| [`zgroups_01`](research/zgroups_01-classification-theory-and-polyhierarchy.md) | Vocabulary (facet/taxonomy/thesaurus/folksonomy). Z39.19, ISO 25964, SKOS, OWL, MeSH, Gene Ontology, Wikipedia categories. Invariants: cycles, diamonds, transitive inheritance. Hierarchical tagging in the wild (path-as-string vs. real edges). Constraint-profile prior art. | Naming a concept, defining a profile, or deciding closure semantics. **The `edgeKinds` finding lives here** — and it changes the model. |
| [`zgroups_02`](research/zgroups_02-storage-indexing-and-query.md) | Adjacency list / materialized path / nested set / closure table / edge table, with explicit **multi-parent** and **re-parent-cost** rows. Write-time vs. read-time closure. Faceted-search internals (Solr, Lucene, Algolia, Meilisearch). Per-backend mapping. Fractional indexing. | Writing a store adapter, or wondering why the "obvious" nested-set answer is wrong. **The two-graphs insight lives here.** |
| [`zgroups_03`](research/zgroups_03-navigation-and-ux-patterns.md) | The navigation catalog with standard terminology. **What changes when it's not a tree.** Search × hierarchy. ARIA and virtualization. | Building any UI surface, or deciding the default view. **`PathNode[]` and the expansion/selection keying rule live here.** |
| [`zgroups_04`](research/zgroups_04-js-ts-library-landscape.md) | Every UI surface with status lines (licence, last release, maintenance, headless?) and a decision table. | **Before adding any dependency.** Several popular picks are frozen, paid, or licence-trapped. |
| [`zgroups_05`](research/zgroups_05-design-patterns-and-architecture.md) | Composite under a DAG (a trap). Canonical relation vs. projections. Datomic, Git, Unix VFS, Zanzibar. The bidirectional-mapping problem. Zod-v4 recursion pitfalls. The TS type sketch. | Writing core model code, or tempted by a famous pattern. |

## Fast answers

| Question | Answer | Where |
|---|---|---|
| Why not nested sets? | *Structurally* incapable of multi-parent — one interval = one position = one parent. | D11, §2.3 |
| Write-time or read-time closure? | Neither — **two graphs.** Materialize the *group DAG* only. | D9/D10, §2.2 |
| Does `poodle ⟹ animal`? | Not from edges alone. Closure belongs to the edge **kind**. | §2.4 |
| Why did my tree open in two places? | You keyed expansion by `nodeId`. Use `pathKey`. | D13 |
| Why are my counts double? | You summed child counts. Use a de-duplicated set over the closure. | D17 |
| Drag = move or add? | **Add.** Move destroys an edge the user can't see. | D16 |
| Is Composite the model? | No. It's the *output* of `projectTree`. | D23 |
| Is there prior art? | **No.** That's the whitespace we occupy. | `zgroups_01` §7 |
