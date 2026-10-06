---
name: zodal-groups-dev-store-adapter
description: Use when building or changing a zodal-groups STORE ADAPTER (@zodal/groups-store-* — Postgres/Supabase, filesystem, S3, IndexedDB/Dexie, localStorage, in-memory) or the GroupStore contract and its test-kit — persisting membership edges, serving closure queries, reporting capabilities honestly. Triggers on "persist the groups", "store adapter", "GroupStore", "groupStoreContract", "createMemoryGroupStore", "groups-store-fs", "sidecar manifest", "recursive CTE", "ltree", "closure table", "nested set", "materialized path", "how do we store the hierarchy", "PostgREST can't do that", "update storm", "re-parent is slow". Read BEFORE choosing an encoding — nested set and materialized path are structurally incapable of multi-parent, and the closure-on-delete problem has a specific, non-obvious answer.
metadata:
  audience: developers
---

# zodal-groups · store adapters

An adapter persists **edges**. That is the whole job. Trees, tags, breadcrumbs, and facets are
computed by `groups-core` from those edges — an adapter never stores a tree.

## The contract is code now — and every adapter runs the kit

The contract lives in `packages/groups-core/src/store.ts` (decision D28), exported from `@zodal/groups-core`:

```ts
interface GroupStore<P = unknown> {
  readonly profile: GroupProfile;                          // code, not data: validates writes, never persisted
  load(): Promise<GroupSpace<P>>;                          // NOT validated against the profile (D8)
  apply(delta: EdgeDelta, options?: { expectedRevision?: number; expectedEpoch?: string })
    : Promise<Result<{ revision: number; epoch: string; inverse: EdgeDelta; space?: GroupSpace<P> }>>;
    // a violation is { ok: false } (stale revision or another epoch → 'conflict'); only I/O rejects.
    // No options ⇒ last write wins. `epoch` = the backing's history id, new if it is re-created.
  getCapabilities(): GroupStoreCapabilities;               // the D19 record, below
  closureIds?(group: NodeId): Promise<NodeId[]>;           // present IFF closure.read === 'native'
  subscribe?(listener: (c: GroupStoreChange) => void): () => void;  // isolate throwing listeners
  dispose?(): void | Promise<void>;
}
```

Shipped: `createMemoryGroupStore()` in groups-core (the default — real, not a stub) and `@zodal/groups-store-fs` (`packages/groups-store-fs`, the reference persistent adapter). IndexedDB and Supabase are TODO.

**Writing an adapter** (copy `groups-store-fs`'s layout):

1. Persist a **snapshot**: `toSnapshot(space)` → flat `nodes[]` + `edges[]` + `revision` (D20). Read back with `parseSnapshot` (structure, throws with the offending path) then `fromSnapshot(snapshot, { profile })` (indexes only). Never treat unreadable data as empty — raise an error naming the location.
2. `apply` = **inside the serialized section**: read current space → `commitDelta(space, delta, options, epoch)` (checks `expectedEpoch` and `expectedRevision`, computes the inverse against *this* state, applies) → if ok, write atomically → `emit({ delta, inverse, revision })` → return the result. Delegating gives you cycle refusal with the path, every profile rule, family rules (D26), tombstones (D25) and the `conflict` check for free. A native backend that validates server-side must produce the same violations and compute the inverse in the same transaction. Return `space` only if you hold it anyway (D10).
3. **Serialize** applies (a promise queue per backing location); a read–modify–write without one loses updates.
4. Use `createListenerSet(onListenerError)` from groups-core for `subscribe`; emit only after the write is durable.
5. Report capabilities honestly. Client-side closure is `CLIENT_SIDE_CAPABILITIES` (`read: 'client'`, `maintainedOnInsert: true`, `maintainedOnDelete: 'exact'` — a read-time walk has no cache to go stale). Only declare `'native'` if you implement `closureIds`.
6. **Run the kit** — this is the acceptance test:

```ts
import { groupStoreContract } from '@zodal/groups-core/testing';

const cases = await groupStoreContract({
  make: async ({ profile, backing, onListenerError, seed }) => {
    if (seed) await writeRaw(locFor(backing), seed);   // foreign data, straight to the backing — never via apply
    return createMyStore({ profile, location: locFor(backing), onListenerError });
  },
  persistent: true,               // two makes with one `backing` open the same data → enables reopen cases
  dispose: ({ backing }) => cleanUp(locFor(backing)),
  // skip: { 'case name': 'why' }  — a documented deviation, never a silent one
});
describe('my adapter: GroupStore contract', () => {
  for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
});
```

The kit (32 cases) checks: empty load; persistence with consistent `forward`/`inverse`; removals; edge kind/label/order/meta and node label/payload/family round-trips; revision monotonic and unchanged on refusal; cycle refused **with a path of real edges** and nothing written; all-or-nothing refusal; family rule; malformed writes refused (the store still loads); `danglingEdge`; the returned inverse round-trips; tombstone and merge undo; stale undo refused (`staleTombstone`, `nodeExists`); `apply`'s returned revision/inverse/space; `expectedRevision` → `conflict`; the two review scenarios (compensation after another writer used the created node; undo after another writer's rename); concurrent applies each get the inverse of *their own* write (exactly one tombstones the contested node, and replaying the inverses newest-first restores the start — catches inverses computed from a stale read); 25 concurrent applies; a diamond keeps its closure; two kinds on one pair; foreign cyclic data loads (`ctx.seed`); a loaded space cannot mutate the store; two instances writing concurrently (persistent); capability well-formedness and closure honesty; subscribe semantics and listener isolation; and (persistent) reopen sees every write and every refusal leaves data untouched. `packages/groups-core/tests/store.test.ts` proves it fails a store that skips validation, lies about native closure, or loses concurrent writes.

### The fs adapter's hardening (the bar for any file-backed store)

- Sidecar manifest JSON (`{ format: 'zodal-groups/manifest', version: 1, revision, nodes, edges }`, 2-space indent, trailing newline — diffable).
- Atomic: temp file in the same dir (exclusive create, pid in the name) + `fsync` + `rename`, then `fsync` the directory (best effort).
- Everything keyed on the **real path** (`realTarget`): one save queue per real file across instances in the process, so a symlinked directory cannot split the queue; a symlinked manifest stays a symlink and its target is replaced.
- **Another process is detected, not overwritten**: the manifest is re-read just before the rename; if it changed since this write read it, nothing is written and `apply` returns `conflict`. Detection, not locking — the check-to-rename window is microseconds, not zero.
- The file mode is kept (`0600` stays `0600`); `mode` sets it for a new manifest.
- Temp files a dead process left (`.<manifest>.<pid>.<n>.tmp`, pid not running) are swept once per manifest per process.
- Unknown top-level fields are preserved; older versions go through a `migrations` map keyed by version (`MANIFEST_MIGRATIONS` + the `migrations` option); a version with no migration is a `ManifestError`.
- A corrupt manifest (invalid JSON, empty, wrong `format`, newer `version`, malformed node/edge) is a `ManifestError` naming the file, for `load` *and* `apply`, and is never overwritten; a failed write rejects without poisoning the queue.

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

`supportsClosure: boolean` is meaningless without saying what happens on **delete**. The real type (`GroupStoreCapabilities` in groups-core):

```ts
interface GroupStoreCapabilities {
  closure: {
    read: 'native' | 'client';                            // recursive CTE vs. in-memory walk
    maintainedOnInsert: boolean;
    maintainedOnDelete: 'exact' | 'rebuild' | 'unsupported';
  };
  ordering: boolean;                                      // the kit checks `order` round-trips
}
```

Facet-count flags (server counts; disjunctive counts need N+1 queries — architectural, not a flag) are **not** in the record until a store offers an optional `facetCounts` method the kit can test (D28 amendment). Add them with the first server-side adapter.

## Per-backend notes (each of these is a real, verified constraint)

- **Postgres / Supabase** — recursive CTE + GIN on the membership array. ⚠️ **PostgREST's filter
  grammar cannot express a subquery or a recursive CTE at all.** You need an **RPC**. (POST also
  dodges the URL-length limit that would kill wide read-time expansion.)
- **Filesystem** — **built**: `@zodal/groups-store-fs`. Keep the DAG in a **sidecar manifest**, not in the directory structure. Hard links
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

- [ ] Persists edges (and nodes, tombstones applied), never trees
- [ ] `apply` returns `applyDelta`'s `Result` (or the same violations from a native validator); only I/O rejects
- [ ] Unreadable stored data is an error naming its location — never an empty space, never overwritten
- [ ] Applies serialized; writes atomic
- [ ] `getCapabilities()` returns the **record**, including `maintainedOnDelete`; `closureIds` iff `'native'`
- [ ] Ordering via fractional index, with binary collation
- [ ] `groupStoreContract` runs green (with `persistent: true` if the data outlives the instance); every `skip` has a reason
- [ ] Added to the package table in `README.md` and `.claude/CLAUDE.md`

## Routing

- Encodings, faceting internals, per-backend mapping: `docs/research/zgroups_02-*`
- The `path_count`/DRed problem and Zanzibar's Leopard index: `docs/research/zgroups_05-*`
- Decisions: [`docs/research/_reconciliation.md`](../../docs/research/_reconciliation.md) (D9, D10, D11, D19, D25, D28, §2.2, §2.3, §6, §8.4)
- The reference adapter: `packages/groups-store-fs/src/index.ts`; the kit: `packages/groups-core/src/testing.ts`
