# zodal-groups — Agent Guide

## Project Stage: CORE BUILT, RENDERERS IN PROGRESS

`@zodal/groups-core` and `@zodal/groups-ui` are implemented and green (54 + 8 tests). The vanilla
renderer runs end-to-end in a real DOM. shadcn and Ark renderers are next.

## What zodal-groups Is

The **grouping/classification specialization** of `zodal`. It gives you what folders and subfolders
are good at — hierarchical organization — without what folders are bad at: *"an item can only be in
one place."*

**The thesis, and everything follows from it:**

> **Membership is the canonical data — a flat set of reified edges. Every folder tree, tag cloud,
> facet browser and breadcrumb is a computed *projection* over those edges. The "only in one place"
> limitation was never in the data; it is a property of one projection.**

A filesystem and a tag cloud are the *same object* with a different `maxParentsPerItem`. That is why
one library covers pure hierarchies, flat tagging, nested groups, Gmail-style labels, taxonomies, and
the general polyhierarchical case — as **constraint profiles** over one model.

## Package Structure

```
packages/
  groups-core/       @zodal/groups-core       — the model, profiles, closure, projections  [BUILT]
  groups-ui/         @zodal/groups-ui         — headless views, drag intent, registry      [BUILT]
  groups-ui-vanilla/ @zodal/groups-ui-vanilla — zero-dep DOM renderers                     [BUILT]
  groups-ui-shadcn/  @zodal/groups-ui-shadcn  — React + shadcn/ui                          [TODO]
  groups-ui-ark/     @zodal/groups-ui-ark     — Ark UI / Zag.js (React + vanilla + Vue…)   [TODO]
  groups-store-*/    @zodal/groups-store-*    — edge persistence                           [TODO]
```

**Dependency rule**: `groups-core ← groups-ui ← groups-ui-*`. Renderers never import from a store.

## Key Architectural Rules

1. **One canonical relation.** A set of reified edges. No separate "folders tree" + "tags map".
2. **`forward`/`inverse` are two INDEXES over one relation**, written together. Index drift is
   *unrepresentable*, not merely unlikely. (This is the answer to `groups_to_tags`/`tags_to_groups`.)
3. **Names and order live on the EDGE**, not the node (Unix dentry / Git tree-entry).
4. **Closure semantics belong to the edge KIND.** A *wheel* is `part_of` a *car*, a *car* `is_a` a
   *vehicle* — **a wheel is not a vehicle.** This is why SKOS's `broader` is non-transitive.
5. **Unified node type.** Group-ness is *having children*, not a type. Brand `NodeId` only.
6. **`EdgeDelta` is the only write primitive.** Undo and change-feeds come free.
7. **Acyclic on WRITE; cycle-safe on READ.** Both — because we don't own our data.
8. **Headless first.** Core emits `PathNode[]`; renderers draw. Never DOM in core.
9. **`pathKey` for the view; `nodeId` for the model.** The single most bug-prone rule here.

## Skills — read the one that matches your task

| Task | Skill |
|---|---|
| The model, profiles, edge kinds, `applyDelta` | `.claude/skills/zodal-groups-dev-model/` |
| Any projection (tree, columns, breadcrumbs, facets, closure) | `.claude/skills/zodal-groups-dev-projections/` |
| Building/changing a UI renderer | `.claude/skills/zodal-groups-dev-renderer/` |
| Persisting edges (Postgres, fs, S3, Dexie) | `.claude/skills/zodal-groups-dev-store-adapter/` |
| "What did we decide, and why?" | `.claude/skills/zodal-groups-dev-research-lookup/` |

Real files live in `skills/`; `.claude/skills/` is a symlink bridge.

## Reference Materials

- **The decisions (SSOT)**: [`docs/research/_reconciliation.md`](../docs/research/_reconciliation.md) — 24 numbered decisions, the conflicts and how they resolved. **Read before designing anything.**
- **The thesis**: [`docs/zodal-groups-concept.md`](../docs/zodal-groups-concept.md)
- **Research corpus**: `docs/research/` — 5 reports, ~3,900 lines, ~264 cited sources. Route via `docs/research/README.md`; don't read linearly.

## Already settled — don't re-litigate without new evidence

- **No new `FilterOperator` in `@zodal/core`.** Closure expands to an id set; the existing
  `arrayContainsAny` does the rest (→ Postgres `&&`, PostgREST `ov`, Dexie `anyOf`).
- **No `allowCycles` flag.** Ever.
- **No `node.parent` accessor** returning an arbitrary "primary parent" — that's the `..` ambiguity
  Unix refused to ship. Call `primaryPath()` so the choice is visible.
- **No recursive Zod schema** for the graph. Zod's own docs: cyclical data infinite-loops.
- **Nested set and materialized path are never the canonical encoding.** Nested set is *structurally*
  incapable of multi-parent; materialized path fails combinatorially.
- **Composite is not the model.** It's the output type of `projectTree`.
- **This is not CQRS.** One relation, two *synchronous* indexes.

## Build & Test

```bash
pnpm install
pnpm --filter @zodal/groups-core test        # 54 tests
pnpm --filter @zodal/groups-ui-vanilla test  # 8 DOM tests (jsdom)
pnpm build                                   # turbo, all packages
```

## Relationship to the rest of the ecosystem

- **`zodal`** — the collections core we specialize. `scopeFilter()` returns a `FilterExpression` its
  `DataProvider` already understands.
- **`zodal-graphs`** — the *general* graph library. `zodal-groups` is the **acyclic,
  containment-shaped special case** — and it is a special case precisely so that closure, counts, and
  breadcrumbs can be well-defined. If someone needs cycles and arbitrary edges, send them there.
- **`zodal-dials`** — proved the "facets are canonical; a tree is one projection" pattern for
  settings. `zodal-groups` generalizes it: dials' facets are the flat, single-level special case.
