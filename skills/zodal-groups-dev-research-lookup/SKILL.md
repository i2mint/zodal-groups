---
name: zodal-groups-dev-research-lookup
description: Use when you need to find WHICH zodal-groups research document answers a question, or what was already decided — before reading, or re-litigating, a decision. Triggers on "what did we pick for X", "which research doc covers Y", "why did we choose Z", "is this decided", "why not nested sets", "why is Composite wrong here", "why don't we allow cycles", "where is this in the research", "did we already decide". Points at the one right doc so you don't read 3,900 lines to answer one question.
metadata:
  audience: developers
---

# zodal-groups · research lookup

**If you read one thing: [`docs/research/_reconciliation.md`](../../docs/research/_reconciliation.md).**
It is the SSOT: 24 numbered decisions (D1–D24), the places the five reports disagreed and how it
resolved, the constraint profiles, and the library picks. Everything below routes *into* it.

The corpus is ~3,900 lines and ~264 cited sources. Do not read it linearly.

## Route by question

| Your question | Go to |
|---|---|
| What is the model, and why edges? | `_reconciliation.md` D1–D7 |
| Why isn't `Item` a different type from `Group`? | D5, D6; `zgroups_05` §5 |
| Why is Composite wrong here? | D23; `zgroups_05` §1 — *its GoF intent literally says tree* |
| Why no cycles? But real taxonomies have them! | D8; `_reconciliation.md` §2.1 — **acyclic on write, cycle-safe on read** |
| Why not nested sets / materialized path? | D11; `_reconciliation.md` §2.3 — nested set is *structurally* incapable of multi-parent |
| Write-time or read-time closure? | D9, D10; §2.2 — **it's a false dichotomy; there are two graphs** |
| Does `poodle ⟹ animal`? | §2.4; `zgroups_01` §4.3 — **not answerable from edges alone.** Edge *kinds* carry closure semantics |
| Why does my tree open in two places? | D13; `zgroups_03` §B.3 — expansion is keyed by `pathKey`, selection by `nodeId` |
| Why is `PathNode[]` flat? | D12; `zgroups_03` §D.2 — one structure serves tree + virtualization + ARIA + icicle + columns |
| How do breadcrumbs work with several parents? | §2.5; `zgroups_03` §B.2 — paths become *routes*, not identities |
| Should drag = move or add? | D16; `zgroups_03` §B — **ADD is the default**; MOVE destroys an invisible edge |
| Why are my counts double? | D17; `zgroups_03` §B — never `Σ children.count` |
| Which tree/DnD library? | §5; `zgroups_04` — and check the **dead/trapped** list first |
| What should the default view be? | §4 — **not the tree.** Miller columns survive polyhierarchy natively |
| How do I express "max 3 levels, max 5 groups per item"? | §3 — profiles |
| Is there prior art for any of this? | `zgroups_01` §7 — **no.** That's the whitespace we occupy |

## The five reports

| # | Report | Owns |
|---|---|---|
| 01 | classification-theory-and-polyhierarchy | Z39.19, ISO 25964, SKOS, OWL, MeSH, GO, Wikipedia categories. Invariants (cycles, diamonds, transitivity). Hierarchical tagging in the wild. The profile vocabulary. **The `edgeKinds` finding.** |
| 02 | storage-indexing-and-query | The encodings head-to-head, with multi-parent and re-parent-cost rows. Faceted-search internals. Per-backend mapping. Fractional indexing. **The two-graphs insight.** |
| 03 | navigation-and-ux-patterns | The navigation catalog + terminology. **What changes under polyhierarchy.** Search × hierarchy. ARIA & virtualization. **`PathNode[]` and the keying rule.** |
| 04 | js-ts-library-landscape | Every UI surface, with status lines and a decision table. What's dead, paid, or a trap. |
| 05 | design-patterns-and-architecture | Composite under a DAG. Canonical relation vs projections. Datomic / Git / Unix VFS / Zanzibar. Zod recursion pitfalls. The type sketch. |

## Things already settled — don't re-litigate without new evidence

- **No new `FilterOperator` in `@zodal/core`.** Closure expands to an id set; the existing
  `arrayContainsAny` does the rest. (We nearly added `descendantOf`. It isn't needed.)
- **No `allowCycles` flag.** Ever.
- **No `node.parent` accessor.** It's the `..` ambiguity Unix refused to ship.
- **No recursive Zod schema** for the graph. Zod's docs say it infinite-loops on cyclical data.
- **This is not CQRS.** One relation, two synchronous indexes.
