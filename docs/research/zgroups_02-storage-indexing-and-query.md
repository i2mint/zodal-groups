# zodal-groups — Research 02: How to Store, Index, and Query a Polyhierarchy

**Scope**: storage encodings, indexing, and query strategies for a *runtime-editable DAG* of groups, where items may belong to many groups and groups may have many parents, sitting on top of `DataProvider<T>` with an honest `ProviderCapabilities` contract.

**Conventions**: cited facts carry Vancouver numbers `[n]`. My own conclusions and design proposals are tagged **[SYNTHESIS]** and are *not* claims about what any source says.

---

## 0. The problem restated, precisely

We have two distinct graphs, and conflating them is the single most common design error in this space:

1. **The group DAG** — `group --parentOf--> group`. Nodes: groups. Edges: containment between groups. This is a *directed acyclic graph*, not a tree (multiple parents allowed), and it is **edited at runtime by users**.
2. **The membership relation** — `item --memberOf--> group`. A many-to-many bipartite relation. Items are never parents of anything.

The query we must answer is *transitive membership*:

> `itemsIn(g) = { i : ∃ g' ∈ descendants*(g) with (i memberOf g') }`
> where `descendants*(g)` is the reflexive-transitive descendant set of `g` in the group DAG.

The `poodle ⊂ dog ⊂ animal` example is exactly this: `itemsIn(animal)` must include items whose only direct membership is `poodle`.

**The asymmetry that drives everything** [SYNTHESIS]: these two graphs have wildly different cardinalities. Taxonomy/group DAGs in real systems are *hundreds to low tens of thousands* of nodes — the polyhierarchy literature treats polyhierarchy as a rare, deliberate exception ("a polyhierarchy usually involves only two broader concepts, not more… more than 2–3 polyhierarchies across an entire faceted taxonomy should be a cause for review") [1]. Item sets, meanwhile, are routinely millions. **Any algorithm whose cost scales with the group DAG is free; any algorithm whose cost scales with the item set on a group edit is a landmine.** Hold that thought — §2 shows it settles the central question.

---

## 1. The canonical encodings, head to head

### 1.1 Adjacency list / edge table (`parent_id`, or `(child_id, parent_id)`)

**What it is.** One row per edge. In the single-parent case this degenerates into a `parent_id` column on the node row; the moment you allow multiple parents it *becomes* a bridging table — **the "adjacency list" and the "pure many-to-many bridging table" are the same encoding, distinguished only by whether you allow more than one row per child** [SYNTHESIS]. This matters: the minimal canonical store for a polyhierarchy is already a well-known, boring thing.

```sql
CREATE TABLE group_edges (
  parent_id uuid NOT NULL REFERENCES groups(id),
  child_id  uuid NOT NULL REFERENCES groups(id),
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX ON group_edges (child_id);   -- for ancestor walks
```

**Queries.**
- *Children / parents*: one index lookup. O(deg).
- *Ancestors / descendants / subtree*: `WITH RECURSIVE`. PostgreSQL evaluates recursive CTEs iteratively: a non-recursive seed term, then repeated evaluation of the recursive term against a working table until it is empty [2]. Cost ≈ O(reachable edges).
- *Cycles*: a recursive CTE over a cyclic graph **loops forever**. PostgreSQL 14+ provides the `CYCLE` clause, which adds `is_cycle` and `path` columns and stops the recursion [2]. The docs explicitly warn that `UNION` (rather than `UNION ALL`) only accidentally prevents *some* cycles, "often a cycle does not involve output rows that are completely duplicate," so explicit cycle detection is still needed [2]. There is also a `SEARCH DEPTH FIRST / BREADTH FIRST … SET ordercol` clause for ordering results [2].

**Writes.** Insert = 1 row. Delete = 1 row. **Re-parent = delete 1 row, insert 1 row.** This is the cheapest write of any encoding, full stop.

**Multi-parent.** *Native and free.* Add a second `(parent, child)` row. Nothing else changes.

**Verdict.** The canonical, lossless source of truth. Its only weakness is read cost, and it is the only encoding whose write cost is O(1) regardless of tree shape.

---

### 1.2 Materialized path / path enumeration (incl. Postgres `ltree`)

**What it is.** Each node stores its full root-to-node path as a string: `Top.Countries.Europe.Russia`. Postgres ships this as the `ltree` extension: labels are alphanumeric/underscore/hyphen, max label length **1000 chars**, max **65535 labels** per path [3].

**Queries.**
- *Descendants / subtree*: `path <@ 'Top.Countries'` — the `<@` operator means "left is descendant of right (or equal)", `@>` is the ancestor direction [3]. Indexable with `GiST (path gist_ltree_ops)`, which supports `<, <=, =, >=, >, @>, <@, @, ~, ?` [3].
- *Ancestors*: **free, and this is the underrated property** — the ancestors are literally the prefixes of the string you already have. No query at all. `subpath()`, `nlevel()`, `lca()` (longest common ancestor) are built in [3].
- *Children (direct only)*: needs an `nlevel(path) = nlevel(parent) + 1` predicate — awkward; you usually keep `parent_id` alongside.
- `lquery` gives regex-ish matching (`*.foo.*`, `*{n,m}`) and `ltxtquery` gives position-independent boolean matching [3].

**Writes.** Insert leaf = 1 row. **Move a subtree = rewrite the `path` of every node in the subtree** — O(|subtree|) row updates, plus GiST index churn.

**Multi-parent — this is the crux.** `ltree` is a *tree* encoding: one path per node. Postgres does offer an `ltree[]` array type with array-flavoured operators (`?@>`, `?<@`, `?~`, `?@`, returning the first matching entry) and a `gist__ltree_ops` index — **which the manual explicitly flags as lossy** [3]. So you *can* force multi-parent by storing the **set of all distinct root-to-node paths** for each group.

**And that is where it explodes** [SYNTHESIS]. The number of distinct root→node paths in a DAG is not bounded by the number of edges — it is bounded by the number of *paths*, which is exponential in depth in the worst case. A "diamond chain" (n/2 stacked diamonds) has 2^(n/2) distinct root-to-leaf paths. Adding **one** edge high in the DAG multiplies the path count of every descendant. Concretely: the same `poodle` node reachable via `animal.dog.poodle` and `pet.dog.poodle` and `working_animal.dog.poodle` needs 3 path entries; add one more parent to `dog` and every path through `dog` doubles. Path duplication is *not* a linear penalty; it is a combinatorial one. This is the reason materialized path is a trap for user-editable polyhierarchies rather than merely "suboptimal."

**Where it *is* fine** [SYNTHESIS]: as a **derived, denormalized read index** for the *rare* polyhierarchy case the taxonomy literature describes (usually ≤2 broader concepts [1]) — i.e. as a *facet-friendly projection* (see §3, the Algolia `lvl0/lvl1/…` encoding is precisely this), never as the source of truth.

---

### 1.3 Nested set model (Celko) — treat it properly, then discard it

**What it is.** Each node gets `lft`/`rgt` integers assigned by a depth-first walk. `X` is in `Y`'s subtree iff `Y.lft < X.lft AND X.rgt < Y.rgt` [4].

**Queries.** Genuinely excellent. Subtree and ancestor membership are numeric range comparisons — no recursion, no joins, B-tree indexable, O(log n + k). "Querying becomes inexpensive: hierarchy membership can be tested by comparing these numbers" [4]. This is why it keeps getting recommended.

**Writes — the first fatal flaw.** Inserting a node requires renumbering every node to its right. Wikipedia: *"Nested sets are very slow for inserts because it requires updating left and right domain values for all records in the table after the insert"* and *"Updating requires renumbering and is therefore expensive"* [4]. In practice an insert near the root touches O(n) rows. Rational-number / nested-interval refinements avoid renumbering "although much more complicated" [4]. For a **user-editable** hierarchy where drag-to-reparent is a first-class UX affordance, an O(n) write on every drag is disqualifying on its own.

**Multi-parent — the second, decisive, fatal flaw.** A `(lft, rgt)` interval encodes *containment in a linear order*. A node can occupy exactly one interval, therefore exactly one position, therefore exactly one parent. Wikipedia states it flatly: *"The model doesn't allow for multiple parent categories. For example, an 'Oak' could be a child of 'Tree-Type', but also 'Wood-Type'"* [4], and accommodating such structures "requires additional tagging or taxonomy systems outside the core model" [4].

**Verdict** [SYNTHESIS]: **nested set is not a candidate.** Not "slow for our workload" — *structurally incapable* of representing the thing we are modelling. It is a tree encoding, and we are not storing a tree. I document it here only so that it is explicitly, permanently eliminated and no future contributor re-litigates it. (Note the perverse trap: nested set is the encoding most likely to be suggested by a naive search for "hierarchy in SQL," because it optimizes exactly the metric — read cost — that everyone benchmarks first.)

---

### 1.4 Closure table / transitive closure table

**What it is.** A second table storing **every** (ancestor, descendant) pair, including self-pairs, with depth. Karwin's canonical schema [5]:

```sql
create table closure (
  ancestor int not null,
  descendant int not null,
  primary key (ancestor, descendant),
  foreign key (ancestor) references nodes(node),
  foreign key (descendant) references nodes(node)
);
```

**Queries.** Trivially fast, single index scan, no recursion:
- Descendants: `SELECT descendant FROM closure WHERE ancestor = ?` [5]
- Ancestors: `SELECT ancestor FROM closure WHERE descendant = ?` [5]
- Depth-limited: add `AND depth <= n`. Direct children: `AND depth = 1`.

**Multi-parent — natively supported, and this is *the* reason it exists.** Karwin, in *SQL Antipatterns*, calls Closure Table "the most versatile of the alternative designs, and the only design that allows a node to belong to multiple trees" [6]. Because it stores *pairs* rather than *positions*, overlapping paths simply coexist: if `poodle` is under both `dog` and `hypoallergenic_breeds`, the closure just contains both `(dog, poodle)` and `(hypoallergenic_breeds, poodle)` plus everything above each. **The closure table is the canonical DAG-native encoding.**

**Storage.** For a tree, |closure| = Σ_v (depth(v)+1) — i.e. O(n·d), and O(n²) for a degenerate chain. **For a DAG it is genuinely O(n²) in the worst case**, since any node may reach any other.

**Writes — the "update storm".**

*Insert a leaf under parent P* — cheap, copy P's ancestor rows [5]:
```sql
INSERT INTO closure (ancestor, descendant)
SELECT ancestor, NEW_ID FROM closure WHERE descendant = PARENT_ID
UNION ALL SELECT NEW_ID, NEW_ID;
```
Cost = |ancestors(P)| + 1 rows.

*Move / re-parent a subtree* — two steps [7]:
```sql
-- 1. delete the "cross edges": paths from outside-ancestors into the subtree
DELETE a FROM TreePaths AS a
JOIN TreePaths AS d ON a.descendant = d.descendant
LEFT JOIN TreePaths AS x
  ON x.ancestor = d.ancestor AND x.descendant = a.ancestor
WHERE d.ancestor = 'D' AND x.ancestor IS NULL;

-- 2. re-insert via a Cartesian product of (ancestors of new home) × (descendants of moved node)
INSERT INTO TreePaths (ancestor, descendant, length)
SELECT supertree.ancestor, subtree.descendant,
       supertree.length + subtree.length + 1
FROM TreePaths AS supertree JOIN TreePaths AS subtree
WHERE subtree.ancestor = 'D' AND supertree.descendant = 'B';
```
The insert is **O(m × n)** where m = |ancestors(new parent)| and n = |nodes in moved subtree| [7]. That is the update storm in its mildest form.

**The DAG-specific horror: edge *deletion*.** In a tree, removing an edge removes exactly the paths that went through it. **In a DAG this is false** — a pair `(a, d)` may still be connected by a *different* route after you delete one edge, so you cannot simply delete the Cartesian product. Two known fixes:

- **Path counting (King & Sagert).** Store a `path_count` per closure row. Maintaining a count of distinct paths between each pair lets you maintain the closure under both insertions and deletions; on deletion each affected tuple's count is decremented by (predecessor count × successor count), and a pair leaves the closure when its count hits zero. The catch, stated in the literature: **these counters can be as large as 2^n**, requiring O(n) word size for O(1) arithmetic — mitigable by doing the arithmetic modulo a random prime, reducing word size to ~2c·lg n [8, 9].
- **Recompute the affected region.** Delete all closure rows whose descendant is in `descendants*(moved)`, then re-derive from the edge table via a recursive CTE. Simple, correct, and — critically — its cost scales with the *group DAG*, not the item set [SYNTHESIS].

**Theoretical complexity of dynamic transitive closure.** Any structure that *explicitly materializes* the closure matrix cannot beat Ω(n²) per update in the worst case, because an update can change Ω(n²) entries [9]. The best known deterministic result matches this: Demetrescu & Italiano maintain fully dynamic transitive closure in **O(n²) amortized time per update with O(1) worst-case query**, by recasting the problem as re-evaluating polynomials over matrices; deletions-only run in O(n) amortized [10, 11]. Semi-dynamic (insert-only or delete-only) variants achieve O(n(q+m)) total for q updates on an n-vertex, m-edge DAG, i.e. **O(n) amortized per operation** over long sequences [8].

Read that again with our numbers in mind [SYNTHESIS]: **O(n²) where n = number of *groups*, not items.** At n = 5,000 groups that is 25M cells in the absolute worst case, and in practice the closure of a realistic taxonomy is far sparser (n·d, with d = depth ≈ 5–8). At n = 5,000 items… no problem, because items are never nodes in this graph. This is the whole ballgame.

**Real-world confirmation.** Remind's engineering team evaluated exactly our three candidates for organizational hierarchies: they started with recursive CTEs ("performance wasn't quite where we wanted it to be"), **rejected nested sets** over maintenance/leaf-churn concerns, and shipped a **materialized transitive closure** maintained by triggers that rematerialize ancestors on hierarchy change, with DB constraints preventing cycles and broken distances at insert time — validated by property-testing thousands of arbitrary tree mutations against a simple in-memory model [12].

---

### 1.5 Graph database (Neo4j / Cypher) — the reference point

**What it is.** Native adjacency; traversal is pointer-chasing rather than index lookups.

**Queries.** Variable-length relationships and quantified path patterns [13]:
```cypher
MATCH (g:Group {id: $id})-[:CONTAINS*0..]->(sub:Group)<-[:MEMBER_OF]-(i:Item)
RETURN DISTINCT i
```
Modern GQL-conformant form uses quantified path patterns: `((:Stop)-[:NEXT]->(:Stop)){1,3}` or `(n)-[:NEXT]->{1,10}(m)` [13].

**Caveat, from the manual.** Quantified path patterns "can end up matching very large numbers of paths, resulting in slow query performance," a risk that intensifies with a large maximum length or an overly general pattern; the recommended mitigations are inline predicates and finite upper bounds [13]. **Note this is the *same* combinatorial path-blowup as materialized path in §1.2** — a DAG has exponentially many paths even when it has linearly many nodes; the graph DB just pays it at read time instead of write time [SYNTHESIS]. `DISTINCT` on the endpoint is mandatory, not optional.

**Verdict.** The right shape of answer, but it is not one of our backends and we cannot require it. Its real lesson for us: **deduplicate at the node level, never enumerate paths.**

---

### 1.6 THE COMPARISON MATRIX

| | **Adjacency / edge table** | **Materialized path (`ltree`)** | **Nested set (Celko)** | **Closure table** | **Graph DB (Neo4j)** |
|---|---|---|---|---|---|
| **Stores** | edges | one path string per node | `(lft, rgt)` per node | all (anc, desc, depth) pairs | edges (native pointers) |
| **MULTI-PARENT SUPPORT** | ✅ **native, free** (just add a row) | ⚠️ **only via `ltree[]` path-set; path count can grow exponentially with DAG depth** [3] | ❌ **IMPOSSIBLE — structurally a tree** [4] | ✅ **native; "the only design that allows a node to belong to multiple trees"** [6] | ✅ native |
| **DYNAMIC RE-PARENTING COST** | ✅ **O(1)** — 1 delete + 1 insert | ❌ O(\|subtree\|) row rewrites + index churn; and *every* affected path-set must be recomputed | ❌ **O(n)** — renumber; *"very slow for inserts… updating requires renumbering"* [4] | ⚠️ **O(\|anc(new)\| × \|desc(moved)\|)** insert [7]; **edge deletion in a DAG needs path-counting or region recompute** [8] | ✅ O(1) |
| **Children** | 1 index scan | `nlevel` predicate (awkward) | `lft/rgt` + depth | `WHERE ancestor=X AND depth=1` | O(deg) |
| **Ancestors** | recursive CTE, O(depth) | ✅ **free — parse the string** [3] | range scan | ✅ 1 index scan [5] | traversal |
| **Descendants / subtree** | recursive CTE | ✅ `path <@ 'a.b'` + GiST [3] | ✅ `BETWEEN lft AND rgt` | ✅ 1 index scan [5] | variable-length pattern [13] |
| **Storage** | O(E) | O(n·d) chars; **O(paths)** if multi-parent | O(n) | O(n·d) tree; **O(n²) DAG worst case** | O(V+E) |
| **Cycle safety** | must check on write; `CYCLE` clause guards reads [2] | cycles are unrepresentable (paths would be infinite) | n/a | O(1) check: is new parent already a descendant? | must check on write |
| **Expressible in zodal's existing filter tree?** | ❌ needs recursion | ⚠️ needs `startsWith` on a path array | ❌ | ⚠️ needs a join/subquery | ❌ |
| **Verdict** | **canonical source of truth** | derived read index only | **ELIMINATE** | **derived query index of choice** | reference model |

---

## 2. THE DECISIVE QUESTION — write-time closure vs. read-time expansion

Restating: item `i` is directly in `poodle`; `poodle ⊂ dog ⊂ animal`. How do we serve `itemsIn(animal)`?

### Option (a) — Materialize the closure **on the item**

Store, per item, the *transitive* set of groups it belongs to: `item.allGroupIds = {poodle, dog, animal, pet, …}` (or an `item_group_closure(item_id, group_id)` table).

- **Read**: `filter: {field: 'allGroupIds', operator: 'arrayContains', value: 'animal'}`. One index probe. Perfect — a GIN / multiEntry / inverted-index lookup. Cannot be beaten.
- **Write, adding item to group**: insert |ancestors(g)| entries. Fine.
- **Write, re-parenting a *group***: ☠️ **Here is the update storm.** Moving `dog` from under `animal` to under `mammal` means *every item transitively under `dog`* must have its `allGroupIds` rewritten. One drag-and-drop in the UI ⇒ **O(items under the subtree)** row updates. For a group near the root of a million-item corpus that is a million writes, a GIN index rebuild storm (GIN maintenance on write-heavy tables with large documents can cut insert throughput substantially [14]), a long transaction, and a UI that must either block or show stale results for minutes.
- **Invalidation**: you now have a derived, denormalized field that can silently drift. Every backend must maintain it. `localStorage` and S3 have no triggers.

### Option (b) — Expand the group id at **read** time

Store only *direct* memberships: `item.groupIds = {poodle}`. Keep the group DAG. At query time compute `D = descendants*(animal)` and issue:

```ts
{ field: 'groupIds', operator: 'arrayContainsAny', value: [...D] }
```

- **Read**: two steps — (i) expand `animal → {animal, dog, poodle, wolf, …}` by BFS over the group DAG; (ii) one disjunctive index probe.
- **Write, adding item to group**: 1 row. **Write, re-parenting a group: 1 row.** No storm. Ever.
- **Cost of step (i)**: it needs the group DAG. **But the group DAG is tiny.** A BFS over 10³–10⁴ nodes is microseconds and a few hundred KB of memory. It ships to the browser in one request and stays there.
- **Cost of step (ii)**: the disjunction width = |descendants*(g)|. For `g = root` this could be the *whole* group set. **This is the real constraint**, and it is backend-specific:
  - Postgres: `groupIds && ARRAY[...]` with GIN — the array-overlap operator `&&` is one of the four GIN-indexed array operators [15, 16]. Handles thousands of terms fine.
  - PostgREST/Supabase over HTTP GET: the expanded list goes in the **URL**. Default nginx header buffers are 2k/8k [17] — a few hundred UUIDs and you get a 414. Mitigation: `POST /rpc/...`, or a server-side subquery.
  - Firestore-class stores: **hard limit of 30 disjunctions** in query normal form (`in`, `array-contains-any`) [18]. Read-time expansion simply *cannot* work past 30 descendants there.
  - IndexedDB/Dexie: `where('groupIds').anyOf([...])` on a `multiEntry` index — fine, but it is an OR of point lookups.

### The verdict [SYNTHESIS]

**The asymmetry does settle it — but not in favour of either (a) or (b) as stated. It settles it in favour of a third option that nobody names explicitly, which I'll call (c).**

Both (a) and (b) make the same unexamined assumption: that "the closure" means *the item-level closure*. It doesn't have to. Split the two graphs (as §0 insisted) and materialize the closure of **only the group DAG**:

### Option (c) — Materialize the **group** closure; keep item memberships direct ★

```
groups(id, …)                                  -- n ≈ 10²–10⁴
group_edges(parent_id, child_id)               -- SOURCE OF TRUTH, O(1) writes
group_closure(ancestor, descendant, min_depth) -- DERIVED, |closure| ≈ n·d  (small!)
item_groups(item_id, group_id, rank)           -- direct memberships only; O(1) writes
  -- or denormalized: item.groupIds: string[]  with GIN / multiEntry index
```

- **Read (server-side capable backend)**: one query, no round trip, no URL bloat:
  ```sql
  SELECT i.* FROM items i
  WHERE i.group_ids && ARRAY(SELECT descendant FROM group_closure WHERE ancestor = $1);
  ```
- **Read (dumb backend)**: expand from the closure held **client-side** (it's a few thousand rows — you can literally keep it all in memory), then `arrayContainsAny`. Identical to option (b).
- **Write, membership change**: O(1). One row. Never touches the closure.
- **Write, group re-parent**: recompute the affected region of a table with ~n·d rows. **Worst case is a full rebuild of the entire group closure — a few thousand rows — which is milliseconds.** The theoretical Ω(n²)/O(n²) bounds on maintaining an explicit closure [9, 10] are *bounds in the number of groups*, and n is small by construction. **You are allowed to be sloppy here.** Blowing away and rebuilding the whole group closure inside the same transaction as the edge edit is a completely legitimate implementation, and it makes correctness trivial (no incremental-deletion path-counting [8], no drift).
- **The update storm is not mitigated. It is *structurally absent*.** There is nothing to storm: no item row is touched when the taxonomy changes.

**Why this is the right call, stated plainly:**

| | (a) item closure | (b) read-time expansion | **(c) group closure** |
|---|---|---|---|
| read | ✅ 1 probe | ⚠️ probe with N-way disjunction | ✅ 1 probe (subquery) or = (b) |
| membership write | ⚠️ O(depth) rows | ✅ O(1) | ✅ O(1) |
| **group re-parent** | ☠️ **O(millions)** | ✅ **O(1)** | ✅ **O(n_groups) ≈ ms** |
| needs group DAG in memory | no | **yes** | only for client-side path |
| disjunction-width limit | immune | ☠️ exposed (30 on Firestore [18]) | immune (server-side path) |
| drift risk | high (derived over items) | none | low (derived over groups; cheap to rebuild from truth) |

**(c) is (b) with the descendant-expansion memoized in the store instead of in RAM.** It keeps (b)'s O(1) writes, and buys back (a)'s single-probe read *without* the storm. Option (a) should exist in zodal only as an **opt-in, explicitly-capability-flagged read index** for backends that both (i) cannot express a subquery and (ii) have a hard disjunction cap — i.e. essentially the Firestore case — and it must be honest that group re-parenting on such a backend is an O(items) background job, not an interactive operation.

---

## 3. What faceted search engines actually do (and what to steal)

### 3.1 Inverted index + facet counting, from first principles

An inverted index maps each *term* to a **set** of document ids (a postings list). Facet counting = intersect the query's result bitset with each facet term's postings list and take the cardinality. Postgres's GIN is explicitly described as this: *"GIN indexes are 'inverted indexes' which are appropriate for data values that contain multiple component values, such as arrays. An inverted index contains a separate entry for each component value"* [15]. Dexie's docs make the same analogy for IndexedDB `multiEntry` indexes: *"similar to GIN index in PostgreSQL"* [19].

**The single most important property for us** [SYNTHESIS]: **a postings list is a SET — a document appears in it at most once.** That is precisely the anti-double-counting mechanism we need (see §3.4). It comes for free *if and only if* we index a **deduplicated set of group ids** per item, rather than a list of paths.

### 3.2 Lucene's taxonomy facet module — the reference implementation

- `FacetsConfig` holds per-dimension config; `setHierarchical(dim, true)` declares that a dimension "contains hierarchical paths with depth greater than 1"; `setMultiValued(dim, true)` declares a doc may have several values [20]. This config is **not stored in the index** — the app must keep index-time and search-time config consistent [20].
- A separate **taxonomy (sidecar) index** assigns a unique integer **ordinal** to each category path the first time it is seen [21].
- **All ancestors are indexed automatically**: *"When a category is added to the index… all its parent categories are added as well."* Indexing `<"author","American","Mark Twain">` produces three tokens: `/author`, `/author/American`, `/author/American/Mark Twain` [21].
- Counting then operates on ordinals stored as doc-values, so facet counts at *any* level are a single pass.

**What to steal** [SYNTHESIS]: **ancestor expansion at index time.** Lucene's `/author`, `/author/American`, … is *exactly* option (a)/(c)'s "write the transitive set" — except Lucene expands *paths* (tree) where we would expand *node ids* (DAG). The DAG-correct analogue of Lucene's trick is: index `item.groupIds = dedupe(⋃_{g ∈ directGroups(i)} ancestors*(g))`. That is option (a). Lucene gets away with it because its taxonomy is *reindex-on-change*; we cannot, because ours is live-editable. Hence (c).

### 3.3 The Algolia hierarchical-facet encoding — document it exactly, because it's the industry's answer

Algolia's `hierarchicalMenu` requires the record to carry a **pre-flattened path ladder** [22]:

```json
[
  {
    "objectID": "321432",
    "name": "lemon",
    "categories": {
      "lvl0": "products",
      "lvl1": "products > fruits"
    }
  }
]
```

Rules, from the docs [22]:
- One attribute **per depth level**: `categories.lvl0`, `categories.lvl1`, `categories.lvl2`, …
- Each level holds the **full path from the root to that level**, not just the leaf label — `lvl1` is `"products > fruits"`, not `"fruits"`.
- Default separator is `" > "` (with a space on each side; get the spacing wrong and the level silently fails to render) [22].
- **Every** level must be declared in `attributesForFaceting` (dot notation), and every level must be listed in the widget's `attributes` array [22].
- `rootPath` lets you anchor below the true root; `showParentLevel` (default `true`) controls whether siblings stay visible when a parent is refined [22].

**Multi-parent — Algolia supports it, and this is the key finding** [22]:
```json
{
  "objectID": "321432",
  "categories": {
    "lvl0": ["products", "goods"],
    "lvl1": ["products > fruits", "goods > to eat"]
  }
}
```
Each level may be an **array of paths**. So an item reachable through two branches carries both root-paths.

**Critical observations** [SYNTHESIS]:
1. This is **materialized path, denormalized onto the item, as an array** — §1.2 and §1.5's path blow-up applies. It is the *product* of the DAG's branching, not the sum.
2. It is a **write-time closure over items** — i.e. **option (a)**. A taxonomy re-parent means reindexing every affected record. Algolia's whole model assumes the taxonomy is authored and the index is rebuilt from a source of truth. **Our hierarchy is live-editable; theirs is not.** This is precisely the assumption we said we're voiding, and it is why we cannot just copy Algolia.
3. **Deduplicate the levels.** If an item sits under `products > fruits` and `products > citrus`, `lvl0` must be `["products"]` — **not** `["products", "products"]` — or the facet count for `products` is wrong. Algolia's own community discussion notes the awkwardness of the hierarchical model and recommends modelling categories as *separate flat facets* where possible [23].

### 3.4 Facet-count correctness under polyhierarchy (the double-counting trap)

The failure mode: item `i` is in `poodle` *and* in `hypoallergenic > poodle`. Both paths lead up to `dog`. A naive counter that increments per **(document, path)** reports `dog: 2` for a single document. The count of a facet node must be **|{ distinct documents reaching it }|**, not **|{ (document, path) pairs }|**.

Three mechanisms, in increasing order of robustness [SYNTHESIS], each grounded in how the engines work:

1. **Postings-list set semantics.** If the item's indexed value is a *set of node ids* (`groupIds: Set<GroupId>`), a doc can appear at most once in any term's postings list [15, 19], so counting is *automatically* distinct-document. **Double-counting becomes unrepresentable.** ← **this is the one to adopt.**
2. **Ordinal deduplication at index time.** Lucene expands ancestors into ordinals [21]; as long as the ordinal *set* per document is deduped before counting, shared ancestors count once. (The Lucene user guide documents the ancestor expansion and the ordinal mechanism but does **not** state the dedup behaviour for two paths sharing an ancestor [21] — so if you build on Lucene/Solr, **verify this empirically**; do not assume.)
3. **Query-side `DISTINCT`.** What Neo4j forces you to do [13] and what any path-enumerating approach must do. Correct but expensive: you pay the path blow-up and then throw it away.

**Rule** [SYNTHESIS]: *never let a path be the unit of counting. The unit is the (item, group-node) pair, and it must be a set.* Encoding groups as **ids in a set**, not **paths in a list**, makes correct polyhierarchical facet counting fall out of the index structure itself, at zero cost.

### 3.5 Conjunctive vs. disjunctive facets — the thing everyone gets wrong

The standard semantics: **within a facet, values OR; across facets, values AND** [24, 25]. Selecting `color=Red` and `color=Blue` shows red *or* blue; adding `brand=Nike` intersects.

The trap is **counts**, not filtering. In the naive (conjunctive) implementation, applying `color=Red` filters the whole result set *including the color facet's own counts* — so `Blue` drops to 0, because no document is both Red and Blue, and the user can no longer see what else is available in the facet they're standing in [25]. Meilisearch documents this bluntly and the fix is architectural, not a flag [25]:

> For each facet that has an active selection, run an **additional query with that facet's own filter removed**, and take its counts.

Meilisearch's recommended shape (multi-search, `limit: 0` on the count-only queries, concurrent execution) [25]:
```javascript
// main: all filters, counts only for facets with no active selection
{ indexUid: "products", filter: "color = Red AND brand = Nike", facets: ["size"] }
// color counts: every filter EXCEPT color
{ indexUid: "products", filter: "brand = Nike", facets: ["color"], limit: 0 }
// brand counts: every filter EXCEPT brand
{ indexUid: "products", filter: "color = Red", facets: ["brand"], limit: 0 }
```
Solr expresses the same idea declaratively via the JSON Facet API's **domain change / filter-exclusion** (`excludeTags`) — a facet can widen or replace its domain to ignore selected filters [26]. Algolia builds it into the client: facets declared *disjunctive* get their counts from a parallel query with their own refinement stripped [24, 27]. Solr's older `facet.pivot` produces a summary table of counts faceted by multiple fields — the original hierarchical-facet mechanism, released in Solr 4.0, now superseded by the JSON Facet API's nested sub-facets [26, 28, 29].

**Implication for zodal-groups** [SYNTHESIS]: **N selected facets ⇒ N+1 backend queries.** This is not an optimization detail; it is a load-bearing part of the contract, and it must show up in `ProviderCapabilities` (`supportsMultiSearch: boolean`) and in the cost model the UI layer reasons about. If a provider can't batch, the UI must either serialize N+1 round-trips or degrade to conjunctive counts and *say so*.

### 3.6 Elasticsearch / OpenSearch / Typesense — the flattening tax

Neither ES nor Typesense has a native hierarchical facet; both make you flatten.

- **ES path-prefix trick**: index the path through the `path_hierarchy` tokenizer, which "takes a hierarchical value like a filesystem path, splits on the path separator, and emits a term for each component in the tree" — `root/middle/leaf` → `root`, `root/middle`, `root/middle/leaf` — then run an ordinary `terms` aggregation over it (requires `fielddata: true` on the text field) [30]. **This is Lucene's ancestor expansion (§3.2) surfaced as an analyzer.** The alternative is nested `terms` aggs, one per level. A third-party plugin (`elasticsearch-aggregation-pathhierarchy`) adds a real hierarchical aggregation with depth control and `minDocCount` [31].
- **Typesense / Meilisearch**: the community pattern is the Algolia one — flatten to `level0`, `level1`, … each holding the full path string, then `facet_by` each [32].

**What this tells us** [SYNTHESIS]: *every* engine ultimately reduces hierarchical faceting to **"expand ancestors into a flat multi-valued field, then run a flat terms facet."** The hierarchy is a *presentation* concern reconstructed at render time from a flat count map. That is a strong signal that our UI layer should do the same: **query flat, render nested.**

---

## 4. Mapping to zodal's concrete backends

### 4.1 Postgres / Supabase (PostgREST) — the full-capability backend

| Capability | Mechanism | Server-side? |
|---|---|---|
| Group DAG traversal | `WITH RECURSIVE` over `group_edges`, with `CYCLE id SET is_cycle USING path` [2] | ✅ but **not reachable through PostgREST's filter grammar** |
| Group closure | `group_closure(ancestor, descendant)` table, maintained by trigger [12] | ✅ |
| Transitive item query | `item.group_ids && ARRAY(SELECT descendant FROM group_closure WHERE ancestor = $1)` | ✅ via **RPC** or a **view** |
| Item membership index | `group_ids uuid[]` + `CREATE INDEX … USING GIN (group_ids)` | ✅ |
| `arrayContainsAny` | `&&` (overlap) [33] — GIN-indexed [15] | ✅ |
| `arrayContains` (all) | `@>` (contains) [33] — GIN-indexed [15] | ✅ |
| Single-path hierarchy | `ltree` + GiST (`gist_ltree_ops`), `<@` / `@>` [3] | ✅ |
| Multi-path hierarchy | `ltree[]` + lossy `gist__ltree_ops` [3] | ⚠️ (see §1.2) |

**The PostgREST question, answered.** Postgres's GIN array operator class supports indexed queries using exactly `<@  @>  =  &&` [15], and PostgREST/Supabase surface these as `cs` (contains, `@>`), `cd` (contained by, `<@`), and `ov` (overlap, `&&`) — the `.contains()`, `.containedBy()`, `.overlaps()` client methods [34]. So **`arrayContainsAny` maps cleanly onto `ov`/`&&` and is fully server-side with a GIN index.** 

But there is **no way to express a recursive CTE, or any subquery, in PostgREST's REST filter grammar.** The filter language is a flat conjunction/disjunction of column predicates. Therefore, for a *server-side* transitive query you have exactly two options:
- **A view** — but a view cannot take the group id as a parameter, so it only works for a fixed anchor. Not useful.
- **An RPC** — `POST /rpc/items_in_group`, a set-returning Postgres function. PostgREST allows functions returning table types to be further filtered, sorted, paginated, and resource-embedded with the *same* query params as tables [35]. **This is the answer**: the RPC returns `SETOF items`, and `DataProvider.getList`'s `sort`/`filter`/`pagination` continue to work on top of it unchanged.

**Practical caveats** [SYNTHESIS]:
- RPC via `POST` also **dodges the URL-length limit** (nginx default `client_header_buffer_size 2k`, `large_client_header_buffers 4 8k` [17]) that would otherwise bite the read-time-expansion path with a wide `in.(…)` list.
- GIN write amplification is real: every write touching the indexed column decomposes the value to update the index; on write-heavy tables this can materially cut insert throughput [14, 36]. Another argument against option (a): the item-level closure means *more* array elements per row *and* rewrites on every taxonomy edit.
- If using RPC with RLS, the function must be `STABLE` and (usually) `SECURITY INVOKER` so row policies still apply.

### 4.2 Filesystem — be honest

The natural encoding is directories, which are **strictly single-parent**. The escape hatches, honestly assessed:

- **Hard links to directories are forbidden** on Linux (and effectively everywhere), specifically because they would create cycles and multiple parents, which breaks `..`, breaks reference-counted deletion, and can corrupt the filesystem; POSIX leaves it implementation-defined but Linux refuses [37]. Hard links to *files* work, giving an item multiple names — but they lose identity (no way to enumerate all names of an inode without scanning the whole tree) and don't survive copy/rsync/zip.
- **Symlinks** technically give you multi-parent for directories, but: `..` no longer means what the path says, `find`/`os.walk` must carry loop detection, and every tool has a different `-L`/`-P` policy. Cycles become *representable*, which means they become *your bug*.

**Recommendation for `zodal-store-fs`** [SYNTHESIS]: **do not encode the DAG in the directory structure.** Store the group DAG and the memberships in a **sidecar manifest** (`.zodal/groups.json` + `.zodal/memberships.json`, or one file per group). Optionally *materialize* a human-browsable **primary-path** directory tree of symlinks as a *projection* (each group gets one canonical parent for display; the other parents exist only in the manifest). Report this in `ProviderCapabilities` as: transitive queries = **client-side**; the filesystem is a blob store here, not an index. Attempting to be clever with symlinks buys a browsable tree and costs correctness.

### 4.3 localStorage / in-memory

Everything is client-side; there is no server to be honest *to*. Load the group DAG (small), build the closure in memory at startup (a BFS/DFS over ≤10⁴ nodes — sub-millisecond), and evaluate the full filter expression tree in JS. `arrayContainsAny` is `groupIds.some(g => descendantSet.has(g))`.

**This is the reference implementation** [SYNTHESIS] — and it should be the *conformance oracle* every other adapter is tested against, per the ecosystem's "test against the DataProvider contract" rule. The in-memory adapter defines what the right answer *is*.

### 4.4 S3 — prefixes are not directories

AWS is unambiguous: *"You can think of prefixes as a way to organize your data in a similar way to directories. However, prefixes are not directories."* [38] The keyspace is flat; `Delimiter` + `Prefix` give you a **browsing** affordance, not an index: *"if you issue a list request with a delimiter, you can browse your hierarchy at only one level, skipping over and summarizing the (possibly millions of) keys nested at deeper levels"* [38]. Keys sharing a substring up to the first delimiter after the prefix are rolled up into a single `CommonPrefixes` element [38, 39].

So `list-objects-v2` with `Delimiter='/'` gives you exactly:
- `Contents` — the objects at *this* level (keys with no further delimiter), and
- `CommonPrefixes` — the *one-level-down* pseudo-directories.

**What it does NOT give you**: any query by anything other than key prefix. No secondary index. No "give me every object whose `groups` attribute overlaps this set." S3 object *metadata* is not queryable [SYNTHESIS].

**Recommendation for `zodal-store-s3`** [SYNTHESIS]: maintain an explicit **inverted index as objects**:
```
groups/dag.json                  # the group DAG (small, single object, cheap to GET)
index/by-group/<groupId>.json    # item ids directly in this group  ← the postings list
items/<itemId>.json
```
Then `itemsIn(g)` = expand `g` via `dag.json` (client-side closure), then GET the postings object for each descendant and union. That is O(|descendants|) GETs — acceptable because the descendant set is small, and trivially parallelizable/cacheable. `ProviderCapabilities`: filtering by group = **server-side by key lookup**; arbitrary field filters = **client-side**; consistency = eventual, so the index objects need a versioned/compare-and-swap write path or a rebuild job. (S3 Select / Athena / an external index exist as escape hatches but pull in a second system.)

### 4.5 IndexedDB / Dexie

A `multiEntry` index "refers to an array property, and where each item in the array is indexed towards the object" — Dexie marks it with a `*` prefix in the schema, and the docs draw the direct analogy to Postgres GIN [19, 40]. So:

```js
db.version(1).stores({ items: 'id, *groupIds, name' });
db.items.where('groupIds').anyOf([...descendants]).toArray();   // ← arrayContainsAny
```

**Two documented limits** [19]:
- **A compound index cannot be `multiEntry`** — the restriction lives in IndexedDB itself, not Dexie. So you cannot index `[tenantId+groupIds]`; combine with a post-filter or a separate index.
- Within a single `WhereClause` you can only query one array element at a time (`anyOf` performs the OR of point lookups); **querying two multiEntry indexes at once is not supported natively** [19]. Cross-field AND must be done by intersecting result sets in JS.

`ProviderCapabilities`: `arrayContainsAny` = server-side (well, engine-side); `and` across two array fields = client-side.

---

## 5. Cycle detection and write-time integrity

**The predicate.** Re-parenting group `G` under `P` creates a cycle **iff `P ∈ descendants*(G)`** (equivalently `G ∈ ancestors*(P)`). That's it — one reachability question.

**Cost, by encoding:**
- **Closure table**: `SELECT 1 FROM group_closure WHERE ancestor = G AND descendant = P` — **O(1) index probe.** This is a free, and very underrated, benefit of option (c) [SYNTHESIS].
- **Edge table only**: a DFS/BFS from `G`, O(V+E) over the *group* DAG. At n ≈ 10³–10⁴ this is microseconds. Do not over-engineer it.
- **Recursive CTE**: guard the traversal itself with the `CYCLE` clause so that a *pre-existing* corruption cannot hang the database [2].

**When the graph is genuinely large.** The dynamic (insertion-only) cycle-detection literature is mature. Bender, Fineman, Gilbert & Tarjan maintain a topological order and detect cycles under arc insertions with total time min(O(m^{3/2}), O(m·n^{2/3})) for a sparse-graph algorithm, and O(n² log n) for a dense-graph algorithm — both improving on prior bounds, and relying on "vertex numberings weakly consistent with topological order, allowing ties" [41, 42]. Bernstein & Chechik later achieved Õ(m√n) expected total time [43]. **None of this is needed at our scale** [SYNTHESIS] — I cite it so that the choice to use naive DFS is a *documented decision* rather than an oversight, and so there's a known upgrade path if someone points zodal-groups at a 10⁷-node ontology.

**Other integrity invariants to enforce transactionally** [SYNTHESIS]:
1. No self-edge (`parent ≠ child`).
2. No duplicate edge (PK on `(parent, child)` gives this free).
3. No cycle (above).
4. The closure is consistent with the edges — enforce by **deriving** the closure inside the same transaction, never by letting callers write it. Remind's approach — triggers that rematerialize on change, plus DB constraints that reject cycles/incorrect distances/broken references *at insert time*, plus property-testing thousands of random tree mutations against an in-memory model — is the pattern to copy [12].
5. Roots are whatever has no parents; do not require a single root. A DAG may have many. (And a group with *zero* parents after an edit is legal — it's a new root, not an error.)

**Where the check lives** [SYNTHESIS]: in the **domain layer**, not the adapter — because `localStorage`/S3 have no triggers and cannot enforce it. The adapter contract should expose an atomic "apply these edge mutations" operation; the domain layer validates before calling it; capable backends *additionally* enforce it as a constraint (defence in depth).

---

## 6. Ordering — and why it belongs on the edge

**The observation that determines the schema.** In a filesystem, "position in the folder" can be a property of the file, because a file is in exactly one folder. **Here it cannot be.** An item in three groups may need to be 1st in one and 47th in another. Therefore **order is a property of the (group, item) membership edge, not of the item** [SYNTHESIS]:

```ts
type Membership = { groupId: GroupId; itemId: ItemId; rank: string };
type GroupEdge  = { parentId: GroupId; childId: GroupId; rank: string };  // same for sub-groups
```

Note this falls out of option (c) for free — we already have the membership row. Option (a)'s "just put an array of group ids on the item" has nowhere to hang the rank, which is an independent argument for keeping an explicit membership relation [SYNTHESIS].

**The rank type: fractional indexing.** The standard solution to "insert between two items without renumbering." Figma's account is the canonical one: give each object a real number index between 0 and 1, and to insert between two objects "set the index for the new object to the average index of the two objects on either side" [44]. Figma stores these as **strings representing arbitrary-precision fractions**, dropping the leading `0.` and using **base-95** (the printable ASCII range) for compactness, rather than 64-bit floats which run out of precision [44].

The de-facto JS library is `rocicorp/fractional-indexing`, based on David Greenspan's *Implementing Fractional Indexing* [45, 46]:
- API: `generateKeyBetween(a, b)` and `generateNKeysBetween(a, b, n)` — the latter produces *shorter* keys than calling the former repeatedly [45].
- Default digit set: **base-62** (`0-9A-Za-z`), with base-52 (`A-Z`/`a-z`) "head" characters encoding the integer part's length [45]. Base-62 is chosen because those 62 digits are in ascending **ASCII byte order**, so a plain binary collation (e.g. SQLite's default `BINARY`) sorts them correctly [47].
- **Gotcha, from the README**: `Array.prototype.sort` works; **`String.prototype.localeCompare` produces incorrect ordering** because it is case-insensitive [45]. Any backend doing the sort must use a **byte/binary collation**, not a locale-aware one. (Postgres: beware `en_US.UTF-8` collation on the rank column — use `COLLATE "C"`.) [SYNTHESIS]

**Documented caveats** [45, 44, 48]:
- **Key length grows** with repeated insertion at the same position. Figma judges this a non-issue because "the number of reordering operations is bounded by user activity" and normal workflows never generate problematically large indices requiring rebalancing [44]. **[SYNTHESIS]** — that reasoning holds for human editing and *fails* for programmatic churn (e.g. an automated re-sort loop); if you ever generate ranks in a loop, use `generateNKeysBetween`.
- **Concurrent insertion interleaves.** If two clients insert between the same neighbours, the results may interleave rather than preserving each client's intent. Figma accepts this ("users can just manually fix the ordering afterwards") and has the server assign unique indices to the second and subsequent concurrent inserts [44]. The library-level mitigation is **jitter**: randomize within the available gap (binary-splitting the range for the desired bits of entropy) so concurrent generators are unlikely to collide [45, 48].

**Fit with `DataProvider`** [SYNTHESIS]: this is the best part. A fractional rank is **just a sortable string column**. `getList({ sort: { field: 'rank', order: 'asc' } })` works on *every* adapter with **zero new capabilities**. No new operator, no new index type, no capability flag. That is a strong argument for choosing it over any integer-gap scheme (which needs periodic renumbering, i.e. a write storm — the exact thing we are trying to eliminate everywhere else in this document).

---

## 7. KEEP / AVOID

### ✅ KEEP

| Idea | Source of the idea | Why |
|---|---|---|
| **Edge table as the source of truth** (`group_edges`) | adjacency list / bridging table (§1.1) | O(1) re-parent; multi-parent is free; lossless |
| **Group closure table as a derived index** (`group_closure`) | closure table (§1.4), Remind [12], Karwin [6] | the only DAG-native encoding; O(1) ancestors/descendants; O(1) cycle check; **and it's small** |
| **Rebuild the group closure eagerly, in-transaction** | §2(c) [SYNTHESIS] | n is tiny; sidesteps all incremental-deletion complexity [8] and all drift |
| **Direct memberships only on items** (`item.groupIds` as a *set*) | §2(c), inverted indexes [15, 19] | O(1) membership writes; **kills the update storm dead**; distinct-doc facet counts fall out for free |
| **`arrayContainsAny` (= `&&` / GIN / multiEntry / `anyOf`) as the transitive read primitive** | Postgres [15, 33], Dexie [19], PostgREST `ov` [34] | already in zodal's operator set — **no new filter operators needed** |
| **RPC for the server-side transitive path on Supabase** | PostgREST [35] | the only way to get a subquery; keeps `sort`/`filter`/`pagination` working; dodges URL length limits [17] |
| **Query flat, render nested** | every engine does this (§3.6) [21, 30, 32] | hierarchy is a presentation concern; the index is flat |
| **N+1 queries for disjunctive facet counts** | Meilisearch [25], Solr `excludeTags` [26], Algolia [24, 27] | within-facet OR + across-facet AND is only *correct* this way; make it a capability, not a surprise |
| **Fractional-index string rank on the (group,item) edge** | Figma [44], rocicorp/Greenspan [45, 46] | order is per-membership, not per-item; sorts as a plain string on every adapter |
| **`CYCLE` clause on every recursive CTE** | PostgreSQL [2] | a corrupted DAG must not hang the database |
| **Honest capability reporting** | zodal's existing contract | `transitiveQuery: 'native' \| 'expanded' \| 'client'`, `maxDisjunctionWidth`, `supportsMultiSearch` |

### ❌ AVOID

| Anti-pattern | Why | Citation |
|---|---|---|
| **Nested set model** | **Structurally cannot represent multiple parents** — it is a tree encoding. Also O(n) renumbering per insert. Disqualified twice over. | [4] |
| **Materialized path / `ltree` as the source of truth** | Assumes one path per node. Forcing multi-parent means storing a path *set*, whose size can grow **exponentially** with DAG depth. `gist__ltree_ops` on `ltree[]` is also **lossy**. | [3], §1.2 |
| **Item-level transitive closure as the default** (the Algolia model) | Re-parenting one group rewrites **every item beneath it** — the update storm. Fine when the taxonomy is authored and reindexed; **fatal when it's live-editable**, which is our whole premise. | §2(a), [22] |
| **Path-based facet counting** | Double-counts any item reaching a facet node via ≥2 paths. Count **distinct items per node**, never (item, path) pairs. | §3.4, [13] |
| **Un-deduplicated `lvl0` arrays** (if you ever do emit an Algolia-style projection) | Two paths sharing `products` ⇒ `["products","products"]` ⇒ wrong count. | §3.3, [22] |
| **Path-counting incremental closure deletion (King & Sagert) as a v1** | Correct, but counters can reach **2^n** and need modular arithmetic to stay word-sized. Enormous complexity for a table with a few thousand rows. Just rebuild. | [8], [9] |
| **Symlinks/hardlinks to encode the DAG on the filesystem** | Hard links to directories are **forbidden** (cycles, `..` corruption); symlinks make cycles representable and break every tree-walking tool differently. | [37], §4.2 |
| **Treating S3 prefixes as directories** | *"Prefixes are not directories."* — AWS. `CommonPrefixes` gives you one level of browsing, not an index. | [38] |
| **`localeCompare` (or a locale-aware DB collation) on fractional rank keys** | Case-insensitive comparison silently corrupts the order of base-62 keys. Use binary/`C` collation. | [45] |
| **Integer-gap ordering (`position: 10, 20, 30`)** | Renumbering *is* a write storm — the exact failure mode we're eliminating everywhere else. | §6 |
| **Recursive CTE as the hot read path** | Works, but Remind moved off it for performance and no engine's filter grammar (PostgREST included) can express it. Fine as the *closure-rebuild* mechanism; not as the per-query path. | [12], [35] |

---

## 8. RECOMMENDED DEFAULT for zodal-groups [SYNTHESIS]

> ### **Edge table (truth) + group-level closure (derived index) + direct-membership set on items (inverted index).**
> ### Expand the group id into its descendant set, then `arrayContainsAny`.

**Canonical model:**
```ts
GroupEdge   = { parentId, childId, rank }        // SOURCE OF TRUTH.  O(1) writes.
GroupClosure= { ancestorId, descendantId, minDepth }  // DERIVED. Rebuilt in-transaction on any edge change.
                                                       // |rows| ≈ n_groups × depth  →  small.
Membership  = { groupId, itemId, rank }          // DIRECT memberships only. O(1) writes.
Item        = { …, groupIds: GroupId[] }         // denormalized SET of DIRECT groups; GIN/multiEntry indexed.
```

**The read, at three capability tiers** — one semantic, three implementations, honestly reported:

| Tier | Backend | `itemsIn(g)` | `ProviderCapabilities.transitiveQuery` |
|---|---|---|---|
| **1. Native** | Postgres/Supabase | RPC: `group_ids && ARRAY(SELECT descendant FROM group_closure WHERE ancestor = $1)` — one round trip, GIN-indexed [15, 35] | `'native'` |
| **2. Expanded** | S3, IndexedDB, any store with a set-index but no subquery | expand `g → D` from the (small, cached) closure client-side, then `arrayContainsAny(groupIds, D)` — engine-side index probe | `'expanded'` (+ `maxDisjunctionWidth`) |
| **3. Client** | filesystem, localStorage, in-memory | expand `g → D` in memory, filter items in JS | `'client'` |

**Fallbacks, in order:**
1. If the backend can't do a subquery → **tier 2** (read-time expansion). Cheap, because the group DAG is small.
2. If the backend *also* caps disjunction width (Firestore's 30 [18]) or the URL blows the header buffer [17] → **chunk the descendant set and union client-side**, or fall back to tier 3.
3. If and only if the backend has *no* set index at all *and* item counts make tier 3 infeasible → **opt in to an item-level transitive closure** (`item.allGroupIds`) as an explicitly-flagged, rebuild-on-taxonomy-change **derived index** — and report in capabilities that group re-parenting is a **background job**, not an interactive operation. This is the Algolia model [22], and it is the *last* resort, not the first.

**The one-sentence rationale.** Every encoding that makes reads fast does so by materializing something; the only question is *what*. Materialize over the **item** set and a single drag-and-drop in the group tree rewrites millions of rows. Materialize over the **group** set — which is three to five orders of magnitude smaller — and you get the same O(1) read, an O(1) cycle check, and a re-parent that costs milliseconds. **The asymmetry between a tiny taxonomy and a huge corpus isn't an incidental property of our domain; it is the resource the design should spend.**

---

## REFERENCES

1. [Polyhierarchy in Taxonomies — Hedden Information Management](https://www.hedden-information.com/polyhierarchy-in-taxonomies/)
2. [PostgreSQL 18 Documentation — 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
3. [PostgreSQL 18 Documentation — F.22. ltree — hierarchical tree-like data type](https://www.postgresql.org/docs/current/ltree.html)
4. [Nested set model — Wikipedia](https://en.wikipedia.org/wiki/Nested_set_model)
5. [Bill Karwin — Rendering Trees with Closure Tables](https://karwin.com/blog/index.php/2010/03/24/rendering-trees-with-closure-tables/)
6. [Bill Karwin — SQL Antipatterns, "Naive Trees" chapter (Pragmatic Bookshelf extract)](https://media.pragprog.com/titles/bksqla/trees.pdf)
7. [Percona Blog — Moving Subtrees in Closure Table Hierarchies](https://www.percona.com/blog/moving-subtrees-in-closure-table/)
8. [Demetrescu & Italiano — Trade-offs for Fully Dynamic Transitive Closure on DAGs (JACM)](https://www.diag.uniroma1.it/demetres/docs/jacm-tc.pdf)
9. [Stanford CS267 — Lecture 11/12: Dynamic Transitive Closure (V. Vassilevska Williams)](http://theory.stanford.edu/~virgi/cs267/lecture12.pdf)
10. [Demetrescu & Italiano — Maintaining Dynamic Matrices for Fully Dynamic Transitive Closure (arXiv cs/0104001)](https://arxiv.org/abs/cs/0104001)
11. [Demetrescu & Italiano — Maintaining Dynamic Matrices for Fully Dynamic Transitive Closure, Algorithmica 51:387–427 (2008)](https://link.springer.com/article/10.1007/s00453-007-9051-4)
12. [Remind Engineering — Transitive Closure in PostgreSQL](https://engineering.remind.com/Transitive-Closure-In-PostgreSQL/)
13. [Neo4j Cypher Manual — Variable-length paths / quantified path patterns](https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-paths/)
14. [PostgreSQL GIN Indexes: JSONB, Arrays & Full-Text Search — DEV Community](https://dev.to/philip_mcclarence_2ef9475/postgresql-gin-indexes-jsonb-arrays-full-text-search-29i2)
15. [PostgreSQL 18 Documentation — 11.2. Index Types (GIN)](https://www.postgresql.org/docs/current/indexes-types.html)
16. [Optimizing Array Queries With GIN Indexes in PostgreSQL — Tiger Data](https://www.tigerdata.com/learn/optimizing-array-queries-with-gin-indexes-in-postgresql)
17. [nginx — client_header_buffer_size / large_client_header_buffers (ngx_http_core_module)](https://nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers)
18. [Query and filter data — Firestore in Native mode (query limits: 30 disjunctions)](https://cloud.google.com/firestore/docs/query-data/queries)
19. [Dexie.js Documentation — MultiEntry Index](https://dexie.org/docs/MultiEntry-Index)
20. [Apache Lucene 9.7.0 — FacetsConfig (setHierarchical, setMultiValued)](https://lucene.apache.org/core/9_7_0/facet/org/apache/lucene/facet/FacetsConfig.html)
21. [Apache Lucene — Facet Userguide (taxonomy index, ordinals, ancestor expansion)](https://lucene.apache.org/core/4_1_0/facet/org/apache/lucene/facet/doc-files/userguide.html)
22. [Algolia — hierarchicalMenu widget API reference (lvl0/lvl1/lvl2, separator, multi-path arrays, rootPath, showParentLevel)](https://www.algolia.com/doc/api-reference/widgets/hierarchical-menu/js)
23. [algolia/instantsearch Discussion #4417 — Why is it recommended to model hierarchical categories as separate facets?](https://github.com/algolia/instantsearch/discussions/4417)
24. [Algolia Support — How can I configure my facet attribute as conjunctive (AND) / disjunctive (OR)?](https://support.algolia.com/hc/en-us/articles/11923043923217-How-can-I-configure-my-facet-attribute-as-conjunctive-AND-disjunctive-OR)
25. [Meilisearch Documentation — Build disjunctive facets](https://www.meilisearch.com/docs/capabilities/filtering_sorting_faceting/advanced/disjunctive_facets)
26. [Apache Solr Reference Guide — JSON Facet API (nested sub-facets, domain changes, refinement)](https://solr.apache.org/guide/solr/latest/query-guide/json-facet-api.html)
27. [Algolia — Faceting guide](https://www.algolia.com/doc/guides/managing-results/refine-results/faceting)
28. [Apache Solr Reference Guide — Faceting (facet.pivot)](https://solr.apache.org/guide/solr/latest/query-guide/faceting.html)
29. [Lucidworks — What are Pivot Facets?](https://lucidworks.com/blog/pivot-facets-inside-and-out)
30. [Findwise — Tree facets with Elasticsearch and Solr: a comparison of two methods](https://findwise.com/blog/comparison-two-different-methods-generating-tree-facets-elasticsearch-solr/)
31. [opendatasoft/elasticsearch-aggregation-pathhierarchy — hierarchical aggregations plugin](https://github.com/opendatasoft/elasticsearch-aggregation-pathhierarchy)
32. [Typesense Documentation — Search API (facet_by, nested fields)](https://typesense.org/docs/latest/api/search.html)
33. [PostgreSQL 18 Documentation — 9.19. Array Functions and Operators (@>, <@, &&)](https://www.postgresql.org/docs/current/functions-array.html)
34. [Supabase Docs — Using filters (contains / containedBy / overlaps → cs / cd / ov)](https://supabase.com/docs/reference/javascript/using-filters)
35. [PostgREST Documentation — Functions as RPC](https://docs.postgrest.org/en/stable/references/api/functions.html)
36. [pganalyze — Understanding Postgres GIN Indexes: The Good and the Bad](https://pganalyze.com/blog/gin-index)
37. [Baeldung on Linux — Why Are Hard Links Not Allowed for Directories?](https://www.baeldung.com/linux/hard-links-not-allowed-for-directories)
38. [Amazon S3 User Guide — Organizing objects using prefixes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-prefixes.html)
39. [Amazon S3 API Reference — ListObjectsV2 (Delimiter, CommonPrefixes)](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
40. [MDN — IDBIndex: multiEntry property](https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex/multiEntry)
41. [Bender, Fineman, Gilbert & Tarjan — A New Approach to Incremental Cycle Detection and Related Problems (arXiv:1112.0784)](https://arxiv.org/abs/1112.0784)
42. [Haeupler, Kavitha, Mathew, Sen & Tarjan — Incremental Cycle Detection, Topological Ordering, and Strong Component Maintenance (arXiv:1105.2397)](https://arxiv.org/pdf/1105.2397)
43. [Bernstein & Chechik — Incremental Topological Sort and Cycle Detection in Õ(m√n) Expected Total Time](https://aaronbernstein.cs.rutgers.edu/wp-content/uploads/sites/43/2018/12/Dynamic-Cycle-Detection.pdf)
44. [Figma Blog — Realtime Editing of Ordered Sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)
45. [rocicorp/fractional-indexing — README (generateKeyBetween, base-62 digits, caveats)](https://github.com/rocicorp/fractional-indexing)
46. [David Greenspan — Implementing Fractional Indexing (Observable)](https://observablehq.com/@dgreensp/implementing-fractional-indexing)
47. [sqliteai/fractional-indexing — lexicographically sortable keys, base62 rationale](https://github.com/sqliteai/fractional-indexing)
48. [nathanhleung/jittered-fractional-indexing — jitter for concurrent index generation](https://github.com/nathanhleung/jittered-fractional-indexing)
49. [Liveblocks — How CRDTs and sync engines keep realtime lists ordered with fractional indexing](https://liveblocks.io/blog/how-crdts-and-sync-engines-keep-realtime-lists-ordered-with-fractional-indexing)
50. [Evolveum — Transitive closure and matrix multiplication in identity management](https://evolveum.com/transitive-closure/)
51. [Ackee — Hierarchical models in PostgreSQL](https://www.ackee.agency/blog/hierarchical-models-in-postgresql)
