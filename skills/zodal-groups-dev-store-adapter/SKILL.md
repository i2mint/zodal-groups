---
name: zodal-groups-dev-store-adapter
description: Use when building or changing a zodal-groups STORE ADAPTER (@zodal/groups-store-* — Postgres/Supabase, filesystem, S3, IndexedDB/Dexie, localStorage, in-memory) — persisting membership edges, serving closure queries, reporting capabilities honestly. Triggers on "persist the groups", "store adapter", "recursive CTE", "ltree", "closure table", "nested set", "materialized path", "how do we store the hierarchy", "PostgREST can't do that", "update storm", "re-parent is slow". Read BEFORE choosing an encoding — nested set and materialized path are structurally incapable of multi-parent, and the closure-on-delete problem has a specific, non-obvious answer.
metadata:
  audience: developers
---

# zodal-groups · store adapters

An adapter persists **edges**. That is the whole job. Trees, tags, breadcrumbs, and facets are
computed by `groups-core` from those edges — an adapter never stores a tree.

## The insight that makes this tractable: there are TWO graphs

Every prior treatment of hierarchy storage conflates them. Separate them and the hard problem
dissolves.

| | the **group DAG** | the **membership relation** |
|---|---|---|
| what | group→group edges (the taxonomy) | item→group edges |
| size | **tiny** — hundreds to low tens of thousands | **huge** — millions |
| changes | rarely (an admin re-parents a folder) | constantly |

## The recommended default encoding

**Materialize the closure of the *group DAG only* — never of the items.**

1. **Edge table is the source of truth.** Re-parenting is **O(1)**: one row.
2. **A derived `group_closure` table** (≈ *n* × depth rows). Because the group DAG is tiny, it is
   **rebuildable in-transaction in milliseconds** — so *rebuild it*, don't incrementally maintain it.
3. **Direct memberships denormalized onto the item** as an indexed **set** (Postgres `GIN`, Dexie
   `multiEntry`).
4. **A read is:** expand group → descendant group ids → `arrayContainsAny([...ids])`.

This gets write-time closure's single-probe reads *and* read-time's O(1) writes. And the crucial
property: **no item row is ever touched when the taxonomy changes.** The "update storm" that sinks
item-level closure materialization is *structurally absent*.

It also means **`path_count` / DRed is a non-problem for us.** (The subtle bug it solves: deleting
edge `3→4` must not delete closure row `(1,4)` if `1→2→4` still exists — a reference count, sound only
under acyclicity, which is the same fact as Unix forbidding hard-linked directories.) We sidestep it
by rebuilding a small table rather than incrementally maintaining a large one.

**And it needs no new filter operator.** `arrayContainsAny` already exists in `@zodal/core` →
Postgres `&&` → PostgREST `ov` → Dexie `anyOf`.

## The encodings, and why the obvious ones are wrong

| encoding | multi-parent? | re-parent cost | verdict |
|---|---|---|---|
| **edge table** | ✅ native | O(1) | ✅ **the canonical store** |
| closure table | ✅ native (precomputes overlapping paths) | expensive on delete (`path_count`) | ✅ as a *derived cache of the group DAG only* |
| adjacency list + recursive CTE | ✅ native | O(1) | ✅ fine; the CTE is the read cost |
| **materialized path / `ltree`** | ❌ **fails combinatorially** | very expensive | ❌ never canonical |
| **nested set** | ❌ **structurally impossible** | very expensive | ❌ never, at all |
| graph DB (Neo4j) | ✅ native | O(1) | reference point |

**Nested set is not merely slow — it is structurally incapable of multi-parent.** It encodes
containment in a *linear order*, so one interval = one position = one parent. ⚠️ It is the encoding
most likely to surface from a naive search, **because it optimizes the one metric everyone benchmarks
first** (subtree read). Do not be tempted.

**Materialized path fails *combinatorially*, not linearly.** Forcing multi-parent means storing a
*path set* per node, and distinct root-paths in a DAG are **exponential in depth** (a diamond chain
gives 2^d). Adding one edge high in the DAG multiplies every descendant's path count. (Postgres's
`ltree[]` GiST opclass is also explicitly **lossy**.)

## Honest capability reporting — a record, not a boolean

`supportsClosure: boolean` is meaningless without saying what happens on **delete**:

```ts
interface GroupStoreCapabilities {
  closure: {
    read: 'native' | 'client';                            // recursive CTE vs. in-memory walk
    maintainedOnInsert: boolean;
    maintainedOnDelete: 'exact' | 'rebuild' | 'unsupported';
  };
  serverFacetCounts: boolean;
  /** Correct DISJUNCTIVE facet counts need N+1 queries. Architectural, not a flag. */
  disjunctiveFacetCounts: 'n-plus-one' | 'unsupported';
  ordering: boolean;
}
```

## Per-backend notes (each of these is a real, verified constraint)

- **Postgres / Supabase** — recursive CTE + GIN on the membership array. ⚠️ **PostgREST's filter
  grammar cannot express a subquery or a recursive CTE at all.** You need an **RPC**. (POST also
  dodges the URL-length limit that would kill wide read-time expansion.)
- **Filesystem** — keep the DAG in a **sidecar manifest**, not in the directory structure. Hard links
  to directories are forbidden by the OS; symlinks make cycles *your* bug. (Note `zodal-store-fs` is
  currently flat — one JSON file per item, non-recursive `readdir`.)
- **S3** — `CommonPrefixes` with `Delimiter=/` is a *browsing affordance, not an index*. Prefixes are
  not directories. You need explicit inverted-index objects.
- **IndexedDB / Dexie** — `multiEntry` index on the membership array; `anyOf` is `arrayContainsAny`.
- **localStorage / in-memory** — everything client-side; closure in memory. Perfectly fine: the group
  DAG is small.

## Ordering

A rank lives on the **edge**, not the item — an item in three groups needs three ranks. Use
**fractional indexing** (`orderBetween`): a plain sortable string, so `sort` works on every backend
with **zero new capabilities**.

⚠️ **Sharp edge:** `localeCompare` and locale-aware DB collations **silently corrupt** base-62 key
order. Use binary comparison; on Postgres declare the column `COLLATE "C"`. The list will be *mostly*
right, which is what makes this bug expensive.

## Checklist

- [ ] Persists edges, never trees
- [ ] `getCapabilities()` returns the **record**, including `maintainedOnDelete`
- [ ] Cycle check on write (or delegate to `groups-core`'s `applyDelta`)
- [ ] Closure served natively where possible; falls back to client-side honestly
- [ ] Ordering via fractional index, with binary collation
- [ ] Tests against the same contract as the in-memory adapter

## Routing

- Encodings, faceting internals, per-backend mapping: `docs/research/zgroups_02-*`
- The `path_count`/DRed problem and Zanzibar's Leopard index: `docs/research/zgroups_05-*`
- Decisions: [`docs/research/_reconciliation.md`](../../docs/research/_reconciliation.md) (D9, D10, D11, D19, §2.2, §2.3, §6)
