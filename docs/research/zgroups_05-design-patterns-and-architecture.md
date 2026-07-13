# zodal-groups — The Design-Pattern and Architecture Lens

> Research report. Cited facts carry Vancouver-style numbers [1]. My own opinions and
> design calls are marked **[SYNTHESIS]** and are not claims about the literature.

---

## 0. Executive summary

The short version, up front, because it inverts the obvious answer:

1. **Composite is a trap for this problem.** Composite is defined for *trees* [1], and every
   ergonomic affordance it offers (uniform `add`/`remove` on `Component`, a `parent`
   back-pointer, naive recursion) degrades or breaks the moment a child is shared by two
   parents. Composite is fine as a *rendering-time projection* type; it is a bad *canonical
   model*. §1.1.
2. **The canonical-edges + projections thesis is right, and it is a well-trodden road.** It is
   not exactly CQRS, and calling it CQRS invites Fowler's warning [10]. The closer and more
   honest precedents are *covering indexes over one universal relation* (Datomic [15,16]),
   *one container with many index views* (Boost.MultiIndex [29]), *bimaps* (relativity's
   `M2M`/`M2M.inv` [28]) and *denormalized closure indexes* (Zanzibar's Leopard [18,19]). §2.
3. **The hard part is not the forward projection, it's incremental *deletion* under a DAG.**
   Two independent, decades-apart engineering communities hit the same wall and solved it the
   same way: Unix refuses hard-linked directories because refcount GC can't reclaim cycles
   [20,21], and closure tables over DAGs need a `path_count` column because deleting one edge
   must not delete a path that is still derivable by another route [38]. In the database
   literature this is the "delete and rederive" (DRed) problem [39,40]. Any adapter that says
   "I do transitive closure server-side" must be forced by the capability contract to say
   *whether it handles deletes correctly*. §2.3.
4. **Members should be a tagged union of `ref` and `value`, and literals should be
   content-addressed into refs at the boundary.** This is the DDD entity/value-object
   distinction [13], glued by an Identity Map [14] and, for literals, by Git's
   content-addressing trick [17]. One abstraction, neither side punished. §3.
5. **Unify items and groups into one node type; make "can contain" a *profile* fact, not a
   *type* fact.** Git (a tree contains trees and blobs) [17] and Unix VFS (a directory is an
   inode) [22] both do this, and it is what makes constraint profiles expressible as
   *predicates over one edge relation* rather than as different schemas. §5.
6. **Do not model the group DAG as a recursive Zod schema.** Zod v4 supports recursion via
   getters/`z.lazy` [31] but explicitly warns "passing cyclical data into Zod will cause an
   infinite loop" [31], recursive inference "is finicky" [31], and there is a live TS 5.9+
   `TS2615` breakage for recursive schemas [32]. Validate *edges* (flat, non-recursive) with
   Zod; keep the graph in a structure Zod never sees. §4.2.

---

## 1. The pattern audit — critically

### 1.1 Composite (GoF) — the famous answer, and the wrong one

**What it actually claims.** "Compose objects into *tree* structures to represent part-whole
hierarchies" [1]. The word *tree* is in the intent, not decoration.

Composite ships with two well-known internal tensions, and a DAG makes both worse:

**(a) Transparency vs. safety.** GoF's own discussion: put `add`/`remove`/`getChild` on
`Component` and clients treat leaves and composites uniformly — but you lose type safety,
because a client can `add()` to a leaf, which leaves must implement as a no-op or an
exception [1,4]. Put them only on `Composite` and you regain safety but clients must
downcast/discriminate [1]. This is a genuine fork with no free option — and note that it is
*exactly* the "everything is a node vs. bipartite" fork of §5 wearing an OO costume. Composite
does not resolve it; it just names it.

**(b) The `parent` back-pointer.** Composite "can optionally define an interface for accessing
a component's parent" [1]. Under a DAG, `component.parent` is *ill-typed*: a shared leaf has
N parents. You get three bad choices: (i) make it `parents: Component[]` (fine, but now every
"walk to root" is a *set* of walks and most Composite recipes silently break); (ii) keep one
"primary" parent (an arbitrary, lie-shaped tiebreak — this is the "canonical folder" hack); or
(iii) drop the pointer and derive parents by index lookup — which concedes that the *graph*,
not the *object*, is the source of truth. Option (iii) is correct, and it is the end of
Composite-as-model: once the parent edge lives in an index outside the node, the node is no
longer a composite; it is a vertex.

**(c) Recursion breaks.** A DAG with sharing means a node reachable by k paths is visited k
times by naive recursion. For aggregation ("how many items under this group?") this
double-counts [2], and for evaluation it is exponential in the worst case: a shared node
evaluated once per path costs `O(2^n)` where memoized evaluation costs `O(n)` [5]. The
classic compiler illustration — `(3+5)*(3+5)` sharing one subtree — is exactly our case [2,3].

**(d) Identity vs. equality.** In a tree, "the child at path `a/b/c`" is a fine identity. In a
DAG, the same node appears at `a/b/c` *and* `x/y/c`, so *path is not identity*. Every
tree-shaped UI (a file browser, a tree view) is built on the assumption path ≡ node, and it is
false here. This is the single biggest practical trap and it will bite the UI layer, not the
core: a `<TreeView>` needs a *per-occurrence* key (`pathKey`), not a node key, or you get
React key collisions and a node that expands/collapses in two places at once. Flyweight (§1.6)
is the right frame for that, not Composite.

**[SYNTHESIS] Verdict on Composite:** *Reject as the canonical model; accept as a projection
output type.* `projectTree(edges, { root, maxDepth })` may perfectly well emit a Composite —
an immutable, de-duplicated, path-keyed tree of `{ node, children, pathKey, sharedWith[] }`.
That is Composite in its correct role: a **derived, read-only, tree-shaped view**, freshly
materialized, with no mutation API and no `parent` pointer. The pattern's name is not an
argument; its *shape assumption* is, and the shape assumption is violated.

### 1.2 Visitor / traversal over a DAG

Visitor's double-dispatch is orthogonal to our problem (we have one node type, §5 — so there
is nothing to double-dispatch on). What matters is the **traversal contract**, and it is a real
API decision the core must expose, not hide:

- **visit-once (memoized).** Each node visited exactly once; cost `O(V+E)`. Correct for
  "collect all descendants", "does group G contain item X", "count distinct items". Requires a
  `Set<NodeId>` of seen nodes [5].
- **visit-per-path.** Each *occurrence* visited; cost = number of paths, potentially
  exponential [5]. Correct for "render the tree", "list all paths to this item", "breadcrumbs".

These are not implementation details — they answer *different questions* and both are needed.
Getting them confused is the #1 source of wrong numbers in polyhierarchical systems ("your
folder says 12 items but the sum of subfolders says 17") [2].

**[SYNTHESIS]** Expose exactly two traversal primitives in the core, named for what they mean,
not how they work: `walkNodes(g, root, visitor)` (dedup, memoized) and `walkPaths(g, root,
visitor, { maxDepth })` (per-occurrence, depth-bounded, with a cycle guard that *throws* rather
than silently truncating, because in our model cycles are an invariant violation, §2.3). Never
ship a single `walk()` and let callers guess.

### 1.3 Observer — for the groups↔tags dual view

Observer is the obvious mechanism for "mutate the forward index, see it in the inverse index".
It is also the wrong *level* at which to solve it. Observer keeps *two independent structures*
in sync by notification — which means the invariant `∀e: e ∈ forward ⟺ e ∈ inverse` is
maintained *procedurally* and can drift if any writer bypasses the notification. That is
literally the index-drift failure mode (§2.3).

The stronger construction is to make drift *unrepresentable*: one canonical edge set, and the
"two views" are *derived*, not *stored*. relativity's `M2M` does exactly this — it is
"represented as two dicts: `{key: set(vals)}` and `{val: set(keys)}`" and "the main job of the
M2M is to broadcast changes to the underlying dict and set instances such that they are kept in
sync" [28]. Boost.Bimap likewise: "a very common implementation of a bidirectional map involves
maintaining two maps" and the container *enforces the invariant* rather than letting clients do
it [30,42]. Boost.MultiIndex generalizes this to N indices over one element collection, and the
docs say the plain part out loud: the concept is "borrowed from relational database
terminology", and the indices "act as views to the internal collection of elements" [29].

**[SYNTHESIS]** Use Observer only at the *outer* seam (core → UI / core → adapter), as a change
stream of `EdgeDelta`s. Inside the core, forward and inverse are two indices of one write —
maintained by one function, in one transaction, with no way to update one without the other.
Observer across the internal boundary is a bug factory.

### 1.4 Strategy / Dependency Injection — the right pattern in the right place

Uncontroversial and load-bearing. Three injection seams:
- **Storage encoding strategy** (adjacency list / closure table / materialized path / nested
  set — each with radically different read/write cost profiles [37,45]).
- **Projection algorithm strategy** (client-side closure vs. delegate to a backend's recursive
  CTE vs. delegate to a precomputed index like Leopard [18,19]).
- **Constraint enforcement strategy** (validate-on-write vs. validate-on-read vs. trust the
  backend's constraint).

This is exactly the house "honest capability reporting" rule: the *core* asks for a closure,
the *adapter* declares whether it can do it natively.

### 1.5 Interpreter / Specification — for "smart"/predicate groups

The Specification pattern (Evans & Fowler [9]) encapsulates a predicate as a first-class,
composable object with `isSatisfiedBy(candidate)`, combinable with `and`/`or`/`not` into a
composite specification [9]. Note the meta-point: Specification is itself "an extension of the
Composite structure" [9] — and here Composite *does* fit, because a boolean expression tree
genuinely is a tree.

This is the right frame for **predicate-defined groups** ("everything tagged `urgent` and not
in `archive`"). It gives you, for free, the thing you actually need: a *reifiable* filter tree
that an adapter can either **interpret client-side** (`isSatisfiedBy` over a fetched set) or
**translate** to SQL/PostgREST/Datalog server-side. That is the same `FilterExpression` seam
the zodal store layer already has.

**[SYNTHESIS]** A group is therefore one of two things, and this is a *core* union, not an
afterthought:
```
extensional group  — membership is an explicit edge set   (a folder / a label)
intensional group  — membership is a Specification        (a saved search / smart folder)
```
Both must satisfy the same read interface `membersOf(g)`. The intensional case is where
`Placeless Documents` landed too: it had to reconcile "live collections backed by database
queries" with "collections manipulable by users" via what it called *fluid collections* [27] —
i.e. hybrid groups that are query-defined but hand-editable (pin/exclude overrides). Expect to
need this; design the union now, ship the extensional case first.

### 1.6 Flyweight — yes, but for *occurrences*, not for items

Flyweight separates *intrinsic* state (shareable, context-independent) from *extrinsic* state
(context-dependent, not shareable) [8]. Map it onto our problem and it is startlingly exact:

- **Intrinsic** = the node itself (id, payload, schema). One instance, shared.
- **Extrinsic** = everything about the node *in a particular group / at a particular path*:
  the display name on that edge, the sort position, the expanded/collapsed UI state, the
  breadcrumb.

This is the same decomposition Unix makes: the **inode** holds the file (intrinsic), the
**dentry** holds `(name → inode)` *in a directory* (extrinsic) [21,22]. Names are not part of
the inode but of the dentry [22]. That is a 50-year-old flyweight.

**[SYNTHESIS] The single most valuable structural decision in this report:** *put edge-local
data on the edge, not on the node.* `{ parent, child, label?, order? }`. Then "the same file in
two folders under two different names" is representable, ordering within a parent is
representable, and the UI's per-occurrence state has a natural key (`pathKey = parentPath +
edgeId`) that is *not* the node id.

### 1.7 Adapter / Facade / Bridge — the plug-in seam

Nothing surprising, but note the distinction worth honoring: **Adapter** (make a foreign store
speak `GroupStore`) is the store-satellite pattern; **Bridge** (vary abstraction and
implementation independently) is what you actually get when `GroupSpace` (abstraction:
profiles, projections, constraints) is decoupled from `GroupStore` (implementation: fs, SQL,
in-memory, RDF triple store). Keeping those two hierarchies separate is what lets you add a
constraint profile without touching an adapter and add an adapter without touching profiles.

### 1.8 Memento / Command — undo of re-parenting

Both work; they differ in what you store [6,7]. Command stores the *operation* plus its inverse
(`undoIt()`) [6]; Memento stores a *snapshot* of state to restore [7].

**[SYNTHESIS]** Here Command wins decisively, and for a structural reason: our canonical state
is *a set of edges*, so every mutation is already a `{ added: Edge[], removed: Edge[] }` delta,
and its inverse is the delta with `added`/`removed` swapped. Undo is free and O(delta), not
O(state). Memento would snapshot the whole graph. Do not build a separate undo subsystem —
make `EdgeDelta` the *only* write primitive and undo falls out. (Note also that re-parenting in
a *materialized path* encoding is the expensive-update case [45], another reason the canonical
form must be edges, not paths.)

### 1.9 Beyond GoF: CQRS, materialized views, event sourcing, projection

- **CQRS**: separate the model you write from the model you read [10,11]. Fowler is blunt:
  "you should be very cautious about using CQRS", and "the majority of cases I've run into have
  not been so good, with CQRS seen as a significant force for getting a software system into
  serious difficulties" [10].
- **Materialized view / read model**: read models are "designed around questions" rather than
  around the write schema, and are typically implemented as pre-computed denormalized views
  updated asynchronously [11].
- **Event sourcing**: store an immutable append-only sequence of changes; projections subscribe
  to the log and each is rebuildable from event zero [12].

See §2.1 for whether we should claim any of these names.

---

## 2. The central question: canonical relation vs. projections

### 2.1 Is "edges + projections" just CQRS?

**No — and we should be careful not to say it is.** The distinguishing property of CQRS as
practiced is *asynchrony and eventual consistency between the write model and the read model*
[10,11]: "read models are not updated instantly… there's always a slight delay between the
write and the read" [11]. That is precisely what we must **not** have. The user's own framing
demands live views: *mutate the forward index, see it in the inverse index*. A stale tag cloud
is a bug, not a tuning parameter.

What we actually want is the *other* tradition, which shares CQRS's insight (one write shape,
many read shapes) but not its consistency model:

| Tradition | Write model | Read models | Consistency |
|---|---|---|---|
| CQRS / event sourcing [10,11,12] | commands / event log | projections | **eventual** |
| DB secondary indexes / Datomic [15,16] | datoms / rows | covering indexes | **synchronous, transactional** |
| Boost.MultiIndex [29] / Bimap [30] | one element collection | N index views | **synchronous, invariant-enforced** |
| relativity `M2M` [28] | one relation | `.inv` live view | **synchronous** |

**[SYNTHESIS]** Say **"one canonical relation, many synchronously-maintained index projections"**
and cite Datomic/MultiIndex, not CQRS. Keep the CQRS/event-sourcing machinery as an *optional
adapter-level capability* (an `EdgeLog` store that happens to be append-only and can rebuild
projections from zero [12]) rather than a core commitment. Reason: the core must be usable as a
plain in-memory data structure in a browser with zero infrastructure. Progressive disclosure
means CQRS is an *option at the far end of the dial*, not the entry price.

### 2.2 Datomic is the best single reference — study it properly

Datomic represents *all* data as 4-tuples `(entity, attribute, value, tx)` — **datoms** [16].
It then maintains several sort orders over that one relation [15,16]:

| Index | Sort | Contains |
|---|---|---|
| **EAVT** | entity/attr/value/tx | all datoms — "efficient access to everything about a given entity" (row-like) [15] |
| **AEVT** | attr/entity/value/tx | all datoms — "efficient access to all values for a given attribute" (column-like) [15] |
| **AVET** | attr/value/entity/tx | indexed attrs only; "more expensive to maintain" [15] |
| **VAET** | value/attr/entity/tx | refs only; "**the reverse index** … allows efficient navigation of relationships in reverse" [15] |

And crucially: "Datomic indexes are **covering indexes**, which means the index actually
contains the datoms, rather than just a pointer to them" [16].

Map this onto zodal-groups and the correspondence is one-to-one:

- an **edge** `(child, parent)` ≈ a datom `(entity, :in-group, value)`.
- **forward index** `parent → children[]` ≈ AVET (given the group, get its members).
- **inverse index** `child → parents[]` ≈ **VAET** — Datomic's reverse index, which exists for
  exactly our reason: given John, find who follows John, not just whom John follows [15].
- the "tags view" and the "folders view" are *not two data structures*. They are **two sort
  orders of one relation.** This is the whole thesis, and Datomic proves it at scale.

Datomic also confirms the cost model we must report honestly: AVET-style indexes are "more
expensive to maintain" and are opt-in per attribute [15]; VAET only covers reference-typed
attributes [15]. Translation for us: *not every projection should be maintained eagerly.*
Some are indexes (maintained on write), some are computed on read, and the capability object
must say which.

### 2.3 Invariants, and the failure modes that actually kill you

**Invariant set (the whole correctness story of the core):**

- **I1 (index agreement).** `(c,p) ∈ forward[p]` ⟺ `(c,p) ∈ inverse[c]`. Enforced by making
  edge-set mutation the *only* writer, à la `M2M` [28] / Bimap [30].
- **I2 (acyclicity).** No cycle in the group→group edges. This is not optional; see below.
- **I3 (profile).** All profile constraints hold (maxDepth, maxParents, membersMayBeGroups…).
- **I4 (referential).** Every edge endpoint resolves to a node (or is an inlined literal, §3).
- **I5 (closure soundness).** If a transitive-closure projection is materialized, it equals the
  closure of the current edge set.

**Failure mode 1 — index drift.** Two structures, two writers. Prevented by construction (I1).
Note this is precisely the class of bug that eager secondary-index maintenance in LSM stores
must go out of its way to prevent: on update you must "produce anti-matter entries to clean up
[the] secondary indexes" of the *old* record, or the index retains phantom entries [43-ish; see
LSM secondary-index literature]. Same bug, bigger machine.

**Failure mode 2 — deletion under multiple derivations (the big one).** This is where a DAG
stops being a tree with extra edges and becomes a genuinely harder problem.

Concretely, in a closure table over a DAG: with edges `1→2`, `2→4`, `1→3`, `3→4`, delete the
edge `3→4`. A tree-derived deletion algorithm deletes the closure row `(1,4)` — but the path
`1→2→4` still exists [38]. "When attempting to apply tree maintenance algorithms to a directed
acyclic graph in which the path between a source vertex and destination vertex is not unique,
the algorithms break" [38]. The standard fix is a **`path_count` column**: decrement, and only
delete closure rows whose count reaches zero [38].

That `path_count` is a **reference count**. And now look at what Unix did with the same idea
(§6.3): refcounts work *only* because cycles are forbidden [20]. The two facts are the same
fact.

In the database literature this generalizes: incremental maintenance of *recursive* views under
deletion is the **DRed (Delete and Rederive)** algorithm of Gupta, Mumick & Subrahmanian —
"first deleting a superset of the tuples that need to be deleted, and then rederiving some of
them" [39]; later refined with derivation counters (`DRed^c`) [40]. Maintaining transitive
closure in SQL under both insertions and deletions is a studied, nontrivial problem [41].

**[SYNTHESIS] The honest-capability consequence.** `getCapabilities()` for a group store must
not have a boolean `transitiveClosure: true`. It must have something like:

```ts
closure: {
  read: 'native' | 'emulated' | 'client';   // can the backend answer descendantsOf()?
  maintainedOnInsert: boolean;
  maintainedOnDelete: 'exact' | 'rebuild' | 'unsupported';  // ← the path_count question
}
```
An adapter that maintains a closure table but has no `path_count` (or equivalent) must report
`maintainedOnDelete: 'rebuild'`, and the core must then either rebuild or refuse. This is the
single most important thing the capability contract buys us, and no one gets it right by
accident.

**Failure mode 3 — cycles.** SKOS, notably, permits `skos:member` to range over collections
(so collections nest) and does *not* formally forbid cyclic nesting [23] — and this is a known
soft spot (the SKOS *reference* also carefully makes `skos:broader` **non-transitive** by
default, with a separate `skos:broaderTransitive` [23], precisely to avoid uncontrolled
inference). We should be stricter than SKOS: **acyclicity is an enforced invariant**, checked
on every group→group edge insert (an `O(V+E)` reachability probe from the proposed parent, or
`O(1)` against a maintained closure if the adapter has one). Rationale in §6.3.

**Failure mode 4 — aggregation double-counting.** "Because DAGs allow for multiple parents for
a single node, the amount from a single node can potentially be included two or more times in
the aggregate of a single parent node" [2]. Every rollup (`count`, `size`, `sum`) in the core
must be defined over the *dedup'd descendant set*, never over path-recursion. This is a
one-line rule that prevents a whole class of "the numbers don't add up" bug reports.

### 2.4 Zanzibar: the industrial proof that "flat edges + a closure index" is the right shape

Google's Zanzibar stores authorization as **relation tuples** — "collections of object-user or
object-object relations", i.e. `object#relation@user`, where the "user" side may itself be a
**userset** (`object#relation`), which is what "allows ACLs to refer to groups and supports
nested group membership" [18,19]. That is *precisely* our model: a flat edge set where the
child of an edge may itself be a group. Permission check = graph reachability [19].

And then the punchline: it wasn't fast enough. "Nested relationships … by default require
multiple serial requests to the backing Spanner database because you need to load direct
children before being able to compute their children" [19]. So Google built **Leopard**, a
separate service maintaining "an in-memory **transitive closure** of all groups that are
subgroups of a higher level group" [19], built offline from a tuple snapshot by "recursively
expanding edges in an ACL graph" [18], and kept fresh via a *watch* stream [19].

**[SYNTHESIS]** Read that as validation *and* as a warning:
- Validation: the canonical model **is** a flat set of `(child, parent)` edges where children
  may be groups. Google, at trillions of tuples, chose exactly this.
- Warning: the closure is a **separate, denormalized, asynchronously-updated projection**, and
  they needed a change-stream to keep it honest. Any zodal-groups adapter that materializes a
  closure inherits that exact obligation — which is why the capability contract (§2.3) must
  expose it, and why the *default* in-memory core should compute closures on demand (correct,
  simple, `O(V+E)`) and only *optionally* maintain them.

### 2.5 Derived state in TS/JS — which reactivity model fits a headless core?

The candidates, honestly assessed against "canonical edges + many derived projections, in a
framework-agnostic core":

| Model | Fit | Problem |
|---|---|---|
| **Reselect** (memoized selectors) [35] | Good conceptually — "selectors can compute derived data, allowing Redux to store the minimal possible state" [35] — which is our thesis verbatim | Redux-shaped by convention; default memoization is size-1 (recompute thrash on interleaved args); composition is manual |
| **MobX computed** | Excellent semantics (auto-tracked derivations) | Requires MobX's observable proxies to own your data — a heavy, opinionated dependency in a "headless core" |
| **Jotai atoms** | Excellent for React | Explicitly a React library; a core cannot depend on it |
| **Zustand** | Fine as a *host*, but "in Zustand you have to manually optimize renders with selectors" [36-adjacent] | Store, not a derivation engine |
| **Signals** | "A signal is a data type that enables one-way data flow by modeling cells of state and computations derived from other state/computations. The state and computations form an **acyclic graph**" [36] — and there's a TC39 standardization effort explicitly so that "different web components won't have to use the same library to interoperably consume and produce signals" [36]; computation is **glitch-free**: "no point in the reactive graph where reading a descendant, deriving from some ancestor, would be out of sync" [36] | Not standard yet (Stage 1) [36]; adds a dependency |

**[SYNTHESIS] Recommendation — do not pick one; expose the seam.** The core should be a
**pure, synchronous, framework-free data structure** with:
1. **Pure projection functions**: `projectTree(edges, opts)`, `projectTagIndex(edges)`,
   `projectFacets(edges, opts)` — total functions of the edge set. Trivially testable, trivially
   memoizable by *any* host (Reselect, `useMemo`, MobX `computed`, a signal).
2. **A version stamp** on the edge set (`revision: number`, bumped on every `EdgeDelta`). This
   is the single primitive every memoizer needs; with it, `createSelector`-style caching works
   with an `O(1)` equality check.
3. **A change stream** (`subscribe(cb: (delta: EdgeDelta) => void)`) — Observer at the outer
   seam only (§1.3), which is exactly the mechanism Zanzibar's Leopard uses to stay fresh [19].
4. **Optional incremental projections**: `Projection<T> = { init(edges): T; apply(prev: T,
   delta: EdgeDelta): T }`. This is the escape hatch for the O(1)-update indexes (forward,
   inverse) while keeping expensive ones (closure, facet counts) recomputable.

Then ship a *separate* `@zodal/groups-react` (or `-signals`) that wires 1–3 into hooks/signals.
The core stays headless; the reactivity choice becomes a Target, per house architecture. Note
the signals proposal's own framing — "a reactive data structure which is independent of the
framework" [36] — is the same instinct; we just refuse to bet on Stage 1.

---

## 3. Literal vs. reference members

### 3.1 The terminology already exists, and it's DDD

- **Entity**: "an object primarily defined by its identity", tracked over time, mutable,
  "equal if they have the same ID" [13].
- **Value object**: "defined solely by their attributes", no identity, immutable, "equal if all
  attributes match", "replaced rather than updated" [13].

`pizza/ingredients → ['cheese','pepperoni']` is a group of **value objects**. `documents/2024 →
[doc#a1b2, doc#c3d4]` is a group of **entities**. Forcing a value object through an identity
indirection is what the user (correctly) calls "silly": you invent an id for `'cheese'`, store
it somewhere, and now you must *resolve* it back to `'cheese'`, having gained nothing.

The complementary patterns for the entity side:
- **Repository** — the resolution boundary (`resolve(id) → T`).
- **Identity Map** — "ensures each object is loaded from a database only once during a single
  business transaction by maintaining an in-memory map of all loaded objects, keyed by their
  unique identity", preventing duplicate objects for the same record [14]. This is what makes
  "the same item in 5 groups" be *one object*, not five — the object-graph counterpart of §1.6's
  Flyweight.
- **Lazy Load / virtual Proxy** — a member reference that materializes its payload on access.
  Note Fowler-adjacent commentary: proxy-based lazy loading keeps the domain model pure;
  *explicit* lazy loading (an `.load()` you must remember to call) does not [13-adjacent].

### 3.2 The trick that dissolves the dilemma: content-addressing

Git resolves exactly this tension and it should be stolen wholesale. Git is "a
content-addressable filesystem — a key-value data store where content is identified by its
SHA-1 hash rather than by filename or location" [17]. `echo 'version 1' | git hash-object`
gives the same hash every time [17]. So for Git there is *no distinction* between "a value" and
"an identity": **the identity is a pure function of the value.** Identical content is stored
once and referenced from many trees [17].

**[SYNTHESIS] The design:**

```ts
type Member<V> =
  | { kind: 'ref';   id: NodeId }                    // entity: identity is extrinsic
  | { kind: 'value'; value: V; id?: NodeId }         // value object: identity is derivable
```

with a per-collection **identity strategy** injected (Strategy pattern, §1.4):

```ts
type IdentityStrategy<V> =
  | { mode: 'extrinsic'; idOf: (v: V) => NodeId }        // v.id — entities
  | { mode: 'content';   hash: (v: V) => NodeId }        // hash(v) — value objects (Git's trick)
```

Consequences, all good:
- The **edge table is uniform**: it always stores `NodeId`s. One relation, one index set, one
  set of projections. No branching in the graph algorithms — this is the whole point.
- For literals, `hash('cheese') = 'cheese'` (or `sha('cheese')`) is a *free, total, injective*
  id function. You get the ref machinery with zero authoring burden and zero resolution cost —
  the "resolve" step is `id => id`.
- For entities, the ref is a real id and `resolve` goes through a **Repository + Identity Map**
  [14].
- **Structural sharing falls out**: two groups containing `'cheese'` share one node, exactly as
  two Git trees share one blob [17].
- **Progressive disclosure**: `defineGroups({ member: z.string() })` gives you literal members
  and never mentions the word "id". `defineGroups({ member: DocSchema, identity: byField('id'),
  resolve: docRepo })` gives you the entity case. Same core, same edges, same projections.

The one honest cost: content-addressed literals are **immutable by construction** (change the
value → change the id → it's a different member). That is *correct* for value objects [13] and
should be documented as such, not hidden.

---

## 4. Type-level and API design in TypeScript

### 4.1 Constraint profiles: runtime config, with a *phantom* type tag

The four (plus) knobs — `maxDepth`, `maxParents`, `membersMayBeGroups`, `groupsMayContainItems`,
`allowCycles`, `ordered`, `namedEdges` — are fundamentally **runtime** facts: they must be
checked on every `addEdge`, and they must be *reported* to adapters and UIs (a renderer needs to
know whether to draw a drag-to-reorder handle).

But there is real value in a **type-level echo** of the profile, via branded/phantom types.
Branded types "add a 'brand' — a phantom property — to a primitive type so the compiler can
distinguish them", exist only at compile time, and have zero runtime cost [34].

**[SYNTHESIS] Both, with a strict division of labor:**

```ts
// Runtime: the single source of truth. Validated. Reported. Enforced.
interface GroupProfile {
  readonly maxDepth: number | null;              // null = unbounded
  readonly maxParentsPerItem: number | null;     // 1 → filesystem; null → tags
  readonly maxParentsPerGroup: number | null;    // 1 → group tree; null → group DAG
  readonly membersMayBeGroups: boolean;          // false → bipartite (Gmail)
  readonly groupsMayContainItems: boolean;       // false → taxonomy skeleton only
  readonly ordered: boolean;
  readonly namedEdges: boolean;                  // dentry-style labels on edges
}

// Type-level: a phantom tag so a GroupSpace<'filesystem'> can't be passed where a
// GroupSpace<'dag'> API is expected, and so conditional types can *remove* APIs.
type Shape = 'tree' | 'forest' | 'nested-tags' | 'flat-tags' | 'dag';
interface GroupSpace<S extends Shape = 'dag'> { readonly __shape?: S; /* ... */ }
```

The payoff of the phantom tag is **API narrowing by conditional type**, which is where
"simple things simple" actually lives:

```ts
// In a tree, a node has AT MOST ONE parent — so the API should say so.
type ParentsOf<S extends Shape> =
  S extends 'tree' | 'forest' ? (id: NodeId) => NodeId | undefined
                              : (id: NodeId) => NodeId[];
```
A filesystem user calls `parentOf(x)` and gets `NodeId | undefined` — no `[0]`, no array
ceremony. A polyhierarchy user gets the array. **Same core, same edges, different surface.**
This is the single best use of the type system in this package, and it is worth the phantom.

Do **not** try to encode `maxDepth: 3` in the type system. Depth is a runtime property of data,
not of the schema; encoding it invites recursive conditional types that blow up inference for
no user benefit.

Ship **named presets** so nobody hand-assembles a profile:
`profiles.filesystem`, `profiles.tags`, `profiles.nestedTags`, `profiles.polyhierarchy`,
`profiles.taxonomy` — each a frozen `GroupProfile` + its `Shape`. Custom profiles remain
possible (open-closed).

### 4.2 Zod v4 and recursion — the critical finding

Zod v4 supports self-reference via **getters** ("to define a self-referential type, use a getter
on the key; this lets JavaScript resolve the cyclical schema at runtime") and mutual recursion
the same way [31]. But the docs also state, plainly:

- **"Recursive type inference can be finicky, and it only works in certain scenarios."** [31]
- Fixing it requires **explicit return-type annotations** on the getters, e.g.
  `get subactivities(): z.ZodNullable<z.ZodArray<typeof Activity>> { ... }` [31].
- **"Passing cyclical data into Zod will cause an infinite loop."** [31]
- Recursive types inside `z.record()` are a known open issue [33].
- **TypeScript 5.9+ breaks recursive Zod inference** with `TS2615` — Zod's use of `Required<>`
  in its input/output types "creates a mapped type transformation that TypeScript 5.9+ no longer
  allows in circular reference chains", and the workaround has been to pin TS ≤ 5.8 [32].

**[SYNTHESIS] Therefore: do not represent the group DAG as a recursive Zod schema. Ever.**

This is not a stylistic preference; it is forced by the third bullet. Our data *is* a DAG with
shared nodes, and a naive materialization of it as nested objects is either exponential (§1.2)
or, if we ever produce a cycle, an infinite loop inside the validator [31]. Instead:

```ts
// What Zod validates: FLAT, NON-RECURSIVE, boring, robust.
const NodeSchema = z.object({ id: NodeIdSchema, kind: z.enum(['item','group']), payload: T });
const EdgeSchema = z.object({
  child:  NodeIdSchema,
  parent: NodeIdSchema,
  label:  z.string().optional(),
  order:  z.number().optional(),
});
const GroupSpaceSchema = z.object({ nodes: z.array(NodeSchema), edges: z.array(EdgeSchema) });
```
Zod validates the **serialized edge relation**. Structure (acyclicity, maxDepth, maxParents) is
checked by a `validateProfile(space, profile) → Diagnostic[]` function, *not* by the type
system and *not* by Zod's recursion machinery. `z.lazy`/getters remain available for the *user's
own payload schemas* if those are genuinely tree-shaped; the group graph itself never touches
them.

Bonus: the flat form is exactly what every backend wants anyway (a `nodes` table and an `edges`
table), so the wire format, the storage format, and the validation format are one thing. SSOT.

### 4.3 Branded IDs — `ItemId` vs `GroupId`?

Branded types give us nominal distinctions for free at compile time [34]. Tempting.

**[SYNTHESIS] No — brand `NodeId`, do not brand `ItemId`/`GroupId`.** Two reasons, and the
second is decisive:

1. Per §5, an item *may itself be a group*. A nominal `ItemId | GroupId` split would force
   casts at exactly the interesting moments, which is the tell-tale sign of a wrong type.
2. Group-ness is a **profile-and-data** fact, not a static fact. In `profiles.polyhierarchy` a
   node becomes a group the moment it acquires an out-edge. The type system cannot know this,
   and pretending it can produces lying types.

Do brand `NodeId` (vs. raw `string`) — that catches the real bug (passing a label where an id
goes). And *do* provide a runtime refinement (`isGroup(space, id): boolean`) plus, where the
profile makes it statically true (bipartite profiles), narrow the surface via the `Shape`
phantom (§4.1). That gives you the type-safety benefit *only where it isn't a lie*.

---

## 5. "Everything is a node" vs. bipartite — the modeling fork

### 5.1 The unified camp

- **Unix / VFS**: "Inodes are filesystem objects such as regular files, directories, FIFOs and
  other beasts" — one inode abstraction covers all [22]. A directory *is* a file. The name lives
  in the **dentry**, not the inode [22]. Everything is a file [22].
- **Git**: a tree entry is `<mode> <type> <sha> <name>` where type ∈ {blob, tree} [17] — a tree
  contains trees *and* blobs, uniformly, addressed the same way. And blobs *are shared*: "both
  trees reference the same single blob object in storage" [17]. Git is a **Merkle DAG with
  structural sharing** — which is, structurally, precisely the thing we are building, minus the
  hashing.
- **Composite** (§1.1): the entire *point* is uniformity of Leaf and Composite behind
  `Component` [1].

### 5.2 The bipartite camp

- **Gmail**: labels are not messages. "One email can have multiple labels" [25]; labels are a
  flat-ish namespace, messages never contain messages.
- **Zotero**: a beautiful *hybrid* and worth a close look — **collections** are hierarchical
  ("each collection can have one or more subcollections") *and* an item "can belong to multiple
  collections and subcollections at the same time"; the docs say it outright: "Collections are
  more like music playlists than folders in your computer filesystem" [24]. Meanwhile **tags**
  are flat, unlimited-per-item [24]. So Zotero ships *two* of our profiles side by side over one
  library — evidence that a single package covering both is a real user need, not a
  generalization for its own sake.
- **Faceted classification**: schemes "based on concurrent use of a number of separate
  hierarchies (facets)" [26] — the facets are a different *kind* of thing than the items.
- **SKOS**: makes the split explicit and *disjoint*: "collections are disjoint from concepts.
  It is therefore impossible to use SKOS semantic relations … to have a collection directly fit
  into a SKOS semantic network" [23]. And SKOS pays for that split: it needs `skos:broader`
  (concept→concept, polyhierarchical: "a SKOS concept can be attached to several broader
  concepts at the same time" [23a/primer]) **and separately** `skos:member` (collection→member)
  — two relations, two sets of rules, two things to explain.

### 5.3 What each buys and costs

| | Unified (`Node` may contain) | Bipartite (`Item` vs `Group`) |
|---|---|---|
| Edge relation | **one**: `(child, parent)` | **two**: item-in-group, group-in-group |
| Algorithms (closure, tree, facets) | written once | written twice, or on a union type anyway |
| Constraint profiles | **expressible as predicates on one relation** | expressible as *presence/absence of a relation* |
| Type safety "a message can't contain a message" | runtime (profile) | compile-time |
| Fits filesystem / Git / VFS | natively | awkwardly (dir is a file) |
| Fits Gmail / SKOS | via `membersMayBeGroups: false` | natively |
| Storage schema | one `edges` table | two tables (or one with a discriminator — i.e. unified again) |

### 5.4 [SYNTHESIS] Recommendation: **unified node, bipartite-as-a-profile**

Model **one** node type and **one** edge relation. Encode the bipartite worlds as *profile
constraints over that relation*:

- `filesystem`  = `{ maxParentsPerItem: 1, maxParentsPerGroup: 1, membersMayBeGroups: true, namedEdges: true, ordered: false }`
- `flat-tags` (Gmail) = `{ maxDepth: 1, maxParentsPerItem: null, membersMayBeGroups: false }`
- `nested-tags` = `{ membersMayBeGroups: true, maxParentsPerGroup: 1, maxParentsPerItem: null }`
- `taxonomy` (groups-of-groups only) = `{ groupsMayContainItems: false }`
- `polyhierarchy` (Zotero collections, Git-like) = all limits `null`

**Why this wins the constraint-profile test — which is the deciding criterion.** Under the
unified model, *every profile is a conjunction of cheap predicates over one edge set*:

```
membersMayBeGroups === false   ⟺   ∀e ∈ edges: ¬isGroup(e.child)
maxParentsPerItem === 1        ⟺   ∀n: |inverse[n]| ≤ 1
maxDepth === d                 ⟺   longestPath(edges) ≤ d
groupsMayContainItems === false ⟺  ∀e: isGroup(e.child)
```
Four one-liners, one validator, one storage schema, one set of projections. Under the bipartite
model you cannot express "filesystem" (where a directory is both a group *and* a member) without
either a union type or a second relation — you've *reintroduced* the unified model, badly.

The bipartite model's only real prize — a compile-time guarantee that a message can't contain a
message — is recoverable where it matters via the `Shape` phantom (§4.1): in a bipartite profile,
narrow `addMember`'s child parameter to `ItemId` at the *facade* while the *core* stays uniform.
Type safety at the edge, uniformity at the center. That is the same trade GoF describes as
transparency-vs-safety [1] — and the resolution is to **stop choosing**: be transparent in the
core, safe in the typed facade.

---

## 6. Reference systems, and what each one teaches

### 6.1 Git — the model to imitate

Content-addressed [17]; a tree contains trees and blobs [17]; **the same blob is referenced by
many trees, stored once** [17]. Git is a polyhierarchical DAG with structural sharing that
*works*, at scale, for 20 years. Two specific steals:
- **Content-addressing as the identity strategy for value members** (§3.2).
- **Edge-carries-the-name.** A blob "does not store the filename … the filename is stored in the
  tree object that references the blob" [17-adjacent, and the tree entry format confirms it: the
  name is in the entry, not the blob]. So the *same* blob can appear as `README` in one tree and
  `readme.txt` in another. That is exactly the affordance we need and it comes free from putting
  `label` on the edge.

What Git does *not* give us: Git's trees are immutable and identified by their *contents*, so
"the same tree in two places" is trivially fine but "rename a group and have it change
everywhere" is impossible (that's a new tree, new hash, new everything). Our groups are mutable
entities, so we take Git's *edge model* but not its *immutability*, and we pay for that with the
index-maintenance obligations of §2.3.

### 6.2 Datomic — see §2.2. The lesson: **the two views are two sort orders of one relation.**

### 6.3 Unix hard links — the crucial cautionary precedent

Here is the thing everyone forgets: **Unix already has polyhierarchy for files.** A hard link is
a directory entry `(name → inode)`, and a file with two hard links is *literally in two
directories at once* [21]. `ln a/x b/y` — done. Multiple parents, one file, no duplication. The
filesystem is already our model *for leaves*.

The OS designers then deliberately drew the line at directories: `ln -d` is forbidden (and
generally requires privileges/is unsupported) [20]. The reasons are worth reciting because each
one is a design requirement for us:

1. **Cycles.** Directory hard links let you build a cycle; the FS is then no longer a DAG. "This
   restriction prevents loops and cycles in the file system tree, and many things are simpler if
   the file system tree has no loops or cycles" [20].
2. **Reference-count GC becomes unsound.** "Reference counting can't deal with cyclic data
   structures, and thus hardlinking directories is disallowed" [20]. A cyclic directory island
   has nonzero refcounts and is unreachable — leaked forever. "If Linux used garbage collection,
   it would be OK to hardlink directories, if very confusing" [20].
3. **Traversal never terminates.** "Backing up the hard drive will never finish because of the
   cycles" — trivially demonstrated with `find` [20].
4. **`..` becomes ill-defined.** "What happens when you delete a directory which has multiple
   parents, from the directory pointed to by `..` — what should `..` now point to?" [20]

**[SYNTHESIS] Four transfers, directly:**

- (1) ⇒ **acyclicity is a hard, enforced invariant (I2)**, not a lint. Every group→group insert
  does a reachability check. The cost is real and must be in the capability report
  (`cycleDetection: 'native' | 'client'`).
- (2) ⇒ if any adapter or projection uses **path/derivation counting** — and closure tables over
  DAGs must [38] — that counting is *only sound under acyclicity*. The `path_count` column [38]
  and the inode `nlink` field are **the same refcount with the same precondition**. Enforce I2 or
  your closure table silently rots.
- (3) ⇒ every traversal must be depth-bounded and cycle-guarded *even though* cycles are
  forbidden, because a corrupt store is a real thing (defense in depth). Guard should **throw a
  diagnostic**, not silently truncate.
- (4) ⇒ **there is no `parent`. There is no `..`.** Do not ship a `node.parent` accessor as a
  convenience-with-an-arbitrary-tiebreak; that is the exact ambiguity Unix refused to accept.
  Ship `parentsOf(id): NodeId[]`, and let the `Shape` phantom collapse it to a scalar only in
  profiles where it provably *is* one (§4.1). Breadcrumbs are a function of a **path**, not of a
  node — which loops back to the Flyweight/dentry insight of §1.6.

### 6.4 RDF / SKOS — membership as a triple

In RDF, membership is *just a triple*: `<collection> skos:member <thing>` [23]. `skos:member`
ranges over the union of `skos:Concept` **and** `skos:Collection`, so collections nest [23].
Concepts are polyhierarchical: "a SKOS concept can be attached to several broader concepts at the
same time" [23a]. Two design lessons:

- **Positive**: the triple/edge *is* the canonical form. RDF got there first; Datomic's datom is
  a triple-plus-time [16]; Zanzibar's relation tuple is a triple [18]. Three independent systems,
  same conclusion. Our edge is a triple. This is the strongest available evidence for the thesis.
- **Negative (learn from the mistake)**: SKOS keeps `skos:broader` **non-transitive** and adds a
  *separate* `skos:broaderTransitive` property [23], and it makes collections **disjoint** from
  concepts [23]. Both are complexity taxes paid to keep inference tractable and to avoid a
  concept/collection identity crisis. We can avoid the first tax entirely (transitivity is a
  *projection* in our model, not a property of the relation — you ask for `descendantsOf()` or
  you ask for `childrenOf()`, and there is no ambiguity), and we should decline the second (§5.4).

### 6.5 Zanzibar — see §2.4. The lesson: **flat tuples are right; the closure is a separate
index with a change-stream, and it is where the engineering actually lives.**

### 6.6 Placeless Documents (Dourish et al.) — the HCI precedent for "no canonical place"

An explicit research attempt "to move away from the standard hierarchical structure of the file
system" while still supporting grouping [27]; documents carry arbitrary name/value **properties**
(passive) and **active properties** (executable) [27]. Its most transferable finding is the
**fluid collection**: the system had to reconcile "wanting to provide 'live' collections backed
by database queries" with "wanting to make these collections manipulable by users" [27] — i.e.
the extensional/intensional hybrid of §1.5. If we ship smart groups, we will need pinned
inclusions and exclusions on top of the predicate. Design the union now.

---

## 7. KEEP / AVOID

### KEEP

| # | Decision | Because |
|---|---|---|
| K1 | **One canonical relation: a flat set of edges `(child, parent, label?, order?)`.** Nothing else is authoritative. | RDF triples [23], Datomic datoms [16], Zanzibar relation tuples [18] all converged here. |
| K2 | **Forward and inverse are two *indexes*, not two structures.** Maintained by one writer, in one transaction. | Datomic's AVET/VAET [15]; relativity `M2M`/`.inv` [28]; Boost.Bimap's enforced invariant [30,42]; Boost.MultiIndex's "indices as views over one collection" [29]. Makes index drift *unrepresentable*. |
| K3 | **Names/order live on the EDGE (dentry-style), not on the node.** | Unix: "names are not part of the inode but rather of the dentry" [22]. Git: the filename is in the tree entry, not the blob [17]. Enables "same item, two groups, two names". |
| K4 | **Unified node type; bipartite-ness is a profile predicate.** | Every profile becomes a one-line predicate over one relation (§5.4). Git [17] and VFS [22] both do it. |
| K5 | **Acyclicity as an enforced invariant.** | The Unix hard-link decision [20], and the precondition for every refcount/path_count scheme [38]. |
| K6 | **Two named traversals: `walkNodes` (memoized, dedup) and `walkPaths` (per-occurrence, depth-bounded).** | Shared-node DAG traversal is `O(2^n)` unmemoized vs `O(n)` memoized [5]; and DAG aggregation double-counts if you conflate them [2]. |
| K7 | **Pure projection functions + a `revision` stamp + a change stream.** No reactivity library in the core. | Reselect's own framing ("compute derived data, store the minimal possible state") [35]; TC39 signals' framing ("a reactive data structure independent of the framework") [36]. Lets any host memoize. |
| K8 | **`EdgeDelta` as the *only* write primitive.** | Undo = swap `added`/`removed` (Command [6], not Memento [7]); event-sourced adapters get a log for free [12]; Zanzibar-style watch/index-refresh gets a feed for free [19]. |
| K9 | **`Member<V> = ref \| value`, with a pluggable `IdentityStrategy` (extrinsic id vs. content hash).** | DDD entity/value-object [13] + Identity Map [14] + Git content-addressing [17]. Neither literals nor entities are punished. |
| K10 | **Honest closure capability: `{ read, maintainedOnInsert, maintainedOnDelete }` — not a boolean.** | The `path_count` problem [38] / DRed [39,40] means "supports transitive closure" is meaningless without saying what happens on delete. |
| K11 | **Specification pattern for intensional ("smart") groups**, translatable server-side or interpretable client-side. | Evans & Fowler [9]; and Placeless's "fluid collections" show hybrids are needed [27]. |
| K12 | **Composite as an *output* type of `projectTree`**, immutable, path-keyed. | Composite is defined for trees [1]; a materialized tree projection *is* a tree, so the pattern finally fits. |
| K13 | **Named profile presets** (`filesystem`, `flatTags`, `nestedTags`, `taxonomy`, `polyhierarchy`) + a `Shape` phantom that narrows the API (`parentOf` scalar in tree profiles). | Progressive disclosure; branded/phantom types are zero-cost [34]. |

### AVOID

| # | Anti-decision | Because |
|---|---|---|
| A1 | **Composite as the canonical model.** | Intent says *tree* [1]; the `parent` pointer is ill-typed under sharing; recursion double-counts [2] and can blow up [5]; path ≠ identity. |
| A2 | **A `node.parent` accessor with an arbitrary "primary parent".** | This is exactly the `..` ambiguity Unix refused [20]. It is a lie that will leak into every breadcrumb. |
| A3 | **Modeling the group graph as a recursive Zod schema (`z.lazy`/getters).** | "Passing cyclical data into Zod will cause an infinite loop" [31]; recursive inference "is finicky" [31]; TS 5.9+ `TS2615` breakage [32]; recursion inside `z.record` is broken [33]. Validate **flat edges**. |
| A4 | **Branded `ItemId` vs `GroupId`.** | An item may *be* a group (§5); group-ness is a data+profile fact, not a static one. Brand `NodeId` only. |
| A5 | **Calling the architecture "CQRS".** | CQRS's defining property is eventual consistency between write and read models [10,11]; ours must be synchronous. And Fowler: "the majority of cases I've run into have not been so good … a significant force for getting a software system into serious difficulties" [10]. |
| A6 | **Two structures (a "folders tree" and a "tags map") kept in sync by Observer.** | That *is* index drift, waiting. One relation, two indexes, one writer (K2). |
| A7 | **Materialized-path or nested-set as the canonical encoding.** | Materialized path is "expensive to update … for re-parenting" [45]; nested sets make updates complex [45]; neither handles multiple parents. Fine as *adapter-level* encodings behind the capability contract; never as the core model. |
| A8 | **A naive closure table with no `path_count`.** | Deleting one edge deletes closure rows still derivable by another path [38]; this is the DRed problem [39,40]. If an adapter can't do it, it must report `maintainedOnDelete: 'rebuild'`. |
| A9 | **Depending on MobX / Jotai / Zustand / signals in `@zodal/groups-core`.** | Headless-first. Reactivity is a Target, not the Model. Ship `-react` / `-signals` satellites. |
| A10 | **Allowing cycles "because it's a graph anyway".** | Kills refcounting [20], kills termination [20], kills closure maintenance [38]. If someone truly needs cycles, they need a graph library — `zodal-graphs` — not this one. |

---

## 8. Recommended architecture sketch

### 8.1 In prose

`@zodal/groups-core` is a **pure, synchronous, framework-free** module holding exactly one piece
of canonical state — a set of edges — plus a `GroupProfile` describing which shapes are legal.
Everything a user ever *looks at* — a folder tree, a tag cloud, a facet browser, a breadcrumb,
an ancestor set — is a **projection**: a pure function of `(edges, profile, options)`.

Writes go through one primitive, `applyDelta(space, delta)`, which (a) validates the delta
against the profile, (b) checks acyclicity if the delta adds a group→group edge, (c) updates the
forward and inverse indexes *together*, and (d) bumps `revision` and emits the delta to
subscribers. Undo is `applyDelta(space, invert(delta))`.

Two indexes are maintained eagerly because they are `O(1)` per edge and every projection needs
them: `forward: Map<NodeId, Set<EdgeId>>` and `inverse: Map<NodeId, Set<EdgeId>>` — Datomic's
AVET and VAET [15], relativity's `M2M` and `M2M.inv` [28]. Everything more expensive (transitive
closure, facet counts, path enumeration) is **computed on read by default**, and *optionally*
maintained incrementally by a registered `Projection<T>` when an adapter or host opts in — with
the deletion caveat (K10, A8) surfaced in capabilities.

Storage adapters (`@zodal/groups-store-*`) implement a `GroupStore` that is fundamentally a
*edge repository* and declares, honestly, which projections it can serve natively (a Postgres
adapter with a recursive CTE: `closure.read = 'native'`; an `ltree`/materialized-path adapter:
fast reads, slow re-parenting [45]; a plain KV adapter: `closure.read = 'client'`). Members
resolve through a `Repository` + `IdentityMap` [14] when they are entities, and through a content
hash when they are values [17].

UI renderers (`@zodal/groups-ui-*`) consume *projection outputs*, which are plain configuration
objects (a `TreeProjection` node carries `{ nodeId, pathKey, label, childCount, sharedWith }`) —
never DOM, never a live graph. `pathKey`, not `nodeId`, is the render key, because in a DAG a
node appears at many paths (§1.1(d), §1.6).

### 8.2 In types

```ts
// ── identity ───────────────────────────────────────────────────────────────
type NodeId = string & { readonly __nodeId: unique symbol };   // branded [34]
type EdgeId = string & { readonly __edgeId: unique symbol };

// ── canonical state: ONE relation. Nothing else is authoritative. ─────────
interface Edge {
  readonly id: EdgeId;
  readonly parent: NodeId;   // the group
  readonly child: NodeId;    // item OR group — unified node model (§5)
  readonly label?: string;   // dentry-style: the NAME lives on the edge (§1.6, K3)
  readonly order?: number;   // position within this parent, if profile.ordered
}

interface Node<P = unknown> {
  readonly id: NodeId;
  readonly payload: P;       // validated by the user's Zod schema — flat, non-recursive (§4.2)
}

// ── constraint profiles (§4.1) ────────────────────────────────────────────
type Shape = 'tree' | 'forest' | 'flat-tags' | 'nested-tags' | 'taxonomy' | 'dag';

interface GroupProfile {
  readonly maxDepth: number | null;
  readonly maxParentsPerItem: number | null;    // 1 → filesystem; null → tags
  readonly maxParentsPerGroup: number | null;   // 1 → group tree; null → group DAG
  readonly membersMayBeGroups: boolean;         // false → bipartite (Gmail [25])
  readonly groupsMayContainItems: boolean;      // false → taxonomy skeleton
  readonly ordered: boolean;
  readonly namedEdges: boolean;
  // NOTE: no `allowCycles`. Cycles are never allowed. See §6.3 / K5 / A10.
}

// ── the space ─────────────────────────────────────────────────────────────
interface GroupSpace<P = unknown, S extends Shape = 'dag'> {
  readonly __shape?: S;                       // phantom — narrows the facade, costs nothing [34]
  readonly profile: GroupProfile;
  readonly revision: number;                  // O(1) memoization key for ANY host (§2.5)
  readonly nodes: ReadonlyMap<NodeId, Node<P>>;
  readonly edges: ReadonlyMap<EdgeId, Edge>;
  readonly forward: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;  // ≈ Datomic AVET [15]
  readonly inverse: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;  // ≈ Datomic VAET [15]
}

// ── the ONLY write primitive (§1.8, K8) ───────────────────────────────────
interface EdgeDelta {
  readonly added:   readonly Edge[];
  readonly removed: readonly EdgeId[];
}
declare function applyDelta<P, S extends Shape>(
  space: GroupSpace<P, S>, delta: EdgeDelta,
): Result<GroupSpace<P, S>, ProfileViolation[]>;   // validates profile + acyclicity
declare function invert(space: GroupSpace, delta: EdgeDelta): EdgeDelta;  // undo, free

// ── members: entity OR value, one relation underneath (§3) ────────────────
type Member<V> =
  | { readonly kind: 'ref';   readonly id: NodeId }
  | { readonly kind: 'value'; readonly value: V };

type IdentityStrategy<V> =
  | { readonly mode: 'extrinsic'; readonly idOf: (v: V) => NodeId }   // entity  [13]
  | { readonly mode: 'content';   readonly hash: (v: V) => NodeId };  // value   [13,17]

// ── projections: everything you can SEE is one of these ───────────────────
interface Projection<T, P = unknown> {
  readonly name: string;
  init(space: GroupSpace<P>): T;
  apply?(prev: T, delta: EdgeDelta, next: GroupSpace<P>): T;   // opt-in incremental
}
// built-ins (pure functions of the edge set):
declare function projectTree(space: GroupSpace, opts: { root: NodeId; maxDepth?: number }): TreeNode[];
declare function projectTagIndex(space: GroupSpace): ReadonlyMap<NodeId, readonly NodeId[]>;
declare function projectFacets(space: GroupSpace, opts: FacetOpts): Facet[];
declare function descendantsOf(space: GroupSpace, id: NodeId): ReadonlySet<NodeId>; // memoized, dedup [5]
declare function pathsTo(space: GroupSpace, id: NodeId): readonly Path[];           // per-occurrence [5]

interface TreeNode {                 // Composite — but as OUTPUT only (§1.1, K12)
  readonly nodeId: NodeId;
  readonly pathKey: string;          // ← the render key. NOT nodeId. A node has many paths.
  readonly label: string;            // from the EDGE
  readonly children: readonly TreeNode[];
  readonly alsoAppearsIn: number;    // parent count > 1 → the UI can badge it
}

// ── intensional (smart) groups: Specification pattern (§1.5) ──────────────
type GroupDefinition<P> =
  | { readonly kind: 'extensional' }                                   // edges
  | { readonly kind: 'intensional'; readonly spec: Specification<P>;   // predicate
      readonly pinned?: readonly NodeId[]; readonly excluded?: readonly NodeId[] };  // "fluid" [27]

// ── honest capability reporting (§2.3, K10) ───────────────────────────────
interface GroupStoreCapabilities {
  readonly reverseIndex: 'native' | 'client';        // parentsOf without a scan
  readonly cycleDetection: 'native' | 'client';
  readonly ordering: boolean;
  readonly closure: {
    readonly read: 'native' | 'emulated' | 'client';
    readonly maintainedOnInsert: boolean;
    readonly maintainedOnDelete: 'exact' | 'rebuild' | 'unsupported';  // ← the path_count question [38]
  };
  readonly maxParentsEnforcement: 'native' | 'client';
}
```

### 8.3 The one-liner tests this design must pass

- *Filesystem*: `defineGroups({ profile: profiles.filesystem })` → `parentOf(x)` returns
  `NodeId | undefined` (phantom-narrowed), `label` on the edge is the filename, `projectTree`
  is the whole UI.
- *Gmail*: `profiles.flatTags` → `membersMayBeGroups: false`, `projectTagIndex` is the sidebar.
- *Zotero* [24]: `profiles.polyhierarchy` for collections **and** `profiles.flatTags` for tags,
  over **the same node set** — two `GroupSpace`s, one item universe. This is the acid test that
  the abstraction is real.
- *Undo a re-parent*: `applyDelta(s, invert(s, d))` — one line, O(delta).
- *"Why is this item here twice?"*: `pathsTo(space, id)` returns both paths. A tree model cannot
  answer this question at all; that is the whole reason this package exists.

---

## REFERENCES

1. [Composite pattern — Wikipedia](https://en.wikipedia.org/wiki/Composite_pattern)
2. [Directed acyclic graphs vs parent-child hierarchies — sqlsunday.com](https://sqlsunday.com/2014/05/25/directed-acyclic-graphs-vs-parent-child-hierarchies/)
3. [Tree-Like Objects — TDD Patterns, XP123](https://xp123.com/tree-like-objects-tdd-patterns/)
4. [Composite Design Pattern — SourceMaking](https://sourcemaking.com/design_patterns/composite)
5. [Verified AIG Algorithms in ACL2 (shared-DAG evaluation: per-path exponential vs. memoized linear)](https://arxiv.org/pdf/1304.7861); see also [The P-Completeness of Inverted Index Traversal: On the Complexity of Evaluating Boolean Query DAGs](https://arxiv.org/pdf/2601.18747)
6. [Command pattern — Refactoring.Guru](https://refactoring.guru/design-patterns/command)
7. [Memento pattern — SourceMaking](https://sourcemaking.com/design_patterns/memento)
8. [Flyweight pattern — Refactoring.Guru](https://refactoring.guru/design-patterns/flyweight)
9. [Specification pattern (Evans & Fowler) — overview](https://jhumelsine.github.io/2024/03/06/specification-design-pattern.html); original paper: [Specifications, Evans & Fowler](https://martinfowler.com/apsupp/spec.pdf)
10. [CQRS — Martin Fowler](https://martinfowler.com/bliki/CQRS.html)
11. [CQRS Pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
12. [Event Sourcing Pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
13. [Value Object — Martin Fowler](https://martinfowler.com/bliki/ValueObject.html); [Implementing value objects — Microsoft Learn (DDD)](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/implement-value-objects); [Entities and Value Objects — SeedStack](http://seedstack.org/guides/ddd-for-beginners/entities-and-value-objects/)
14. [Identity Map pattern (Fowler, PoEAA)](https://grokipedia.com/page/identity_map_pattern)
15. [Indexes — Datomic documentation](https://docs.datomic.com/indexes/index-model.html)
16. [Unofficial guide to Datomic internals — Nikita Prokopov (tonsky)](https://tonsky.me/blog/unofficial-guide-to-datomic-internals/)
17. [Git Internals — Git Objects (Pro Git book)](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
18. [Zanzibar: Google's Consistent, Global Authorization System — USENIX ATC '19](https://www.usenix.org/system/files/atc19-pang.pdf)
19. [What is Google Zanzibar? — AuthZed](https://authzed.com/blog/what-is-google-zanzibar)
20. [Why are hard links to directories not allowed in UNIX/Linux? — Unix & Linux Stack Exchange](https://unix.stackexchange.com/questions/22394/why-are-hard-links-to-directories-not-allowed-in-unix-linux)
21. [Hard links and Unix file system nodes (inodes) — Ian! D. Allen](https://teaching.idallen.com/dat2330/04f/notes/links_and_inodes.html)
22. [Overview of the Linux Virtual File System — Linux Kernel documentation](https://docs.kernel.org/filesystems/vfs.html)
23. [SKOS Simple Knowledge Organization System Reference — W3C](https://www.w3.org/TR/skos-reference/); 23a. [SKOS Primer — W3C](https://www.w3.org/TR/skos-primer/)
24. [Collections and Tags — Zotero Documentation](https://www.zotero.org/support/collections_and_tags)
25. [Gmail labels vs. folders — Notion](https://www.notion.com/blog/gmail-labels-vs-folders)
26. [Faceted Classification and Faceted Taxonomies — Hedden Information Management](https://www.hedden-information.com/faceted-classification-and-faceted-taxonomies/)
27. [Extending Document Management Systems with User-Specific Active Properties (Placeless Documents) — Dourish et al., ACM TOIS](https://www.dourish.com/publications/2000/tois-placeless.pdf)
28. [relativity — PyPI (M2M, M2M.inv, M2MChain, M2MStar, M2MGraph)](https://pypi.org/project/relativity/)
29. [Boost.MultiIndex Containers Library](https://www.boost.org/doc/libs/release/libs/multi_index/)
30. [Boost.Bimap — MultiIndex to Bimap path](https://www.boost.org/doc/libs/1_82_0/libs/bimap/doc/html/boost_bimap/examples/multiindex_to_bimap_path___bidirectional_map.html)
31. [Zod v4 — Recursive objects (API docs)](https://zod.dev/api?id=recursive-objects)
32. [TypeScript 5.9+ causes TS2615 errors in recursive type definitions — zod issue #5035](https://github.com/colinhacks/zod/issues/5035)
33. [[v4] Recursive types inside z.record() — zod issue #4881](https://github.com/colinhacks/zod/issues/4881)
34. [Nominal vs Structural Typing / branded types — Stanza](https://www.stanza.dev/courses/typescript-architecture/branded-types/typescript-architecture-nominal-typing); [Branded Types in TypeScript — Nana Adjei Manu](https://nanamanu.com/posts/branded-types-typescript/)
35. [Reselect — Getting Started](https://reselect.js.org/introduction/getting-started)
36. [tc39/proposal-signals — README](https://github.com/tc39/proposal-signals/blob/main/README.md)
37. [SQL Server Closure Tables: Model Hierarchies in SQL — Redgate Simple Talk](https://www.red-gate.com/simple-talk/databases/sql-server/t-sql-programming-sql-server/sql-server-closure-tables/)
38. [Working with Graphs in Postgres Part 2: Extending the Closure Table Pattern to Support DAGs (the `path_count` fix)](https://lnagle.github.io/extended-closure-table-pattern.html)
39. [Maintaining Views Incrementally — Gupta, Mumick & Subrahmanian, SIGMOD 1993 (the DRed algorithm)](https://dl.acm.org/doi/10.1145/170035.170066)
40. [Maintenance of Datalog Materialisations Revisited — Motik et al. (DRed and DRed^c)](http://www.cs.ox.ac.uk/people/boris.motik/pubs/mnph19maintenance-revisited.pdf)
41. [Maintaining Transitive Closure of Graphs in SQL — Dong & Libkin](https://homepages.inf.ed.ac.uk/libkin/papers/tc-sql.pdf)
42. [Designing a generic bidirectional map — jub0bs.com](https://jub0bs.com/posts/2020-07-21-go-bimap/)
43. [LSM-based Storage Techniques: A Survey (eager secondary-index maintenance, anti-matter entries)](https://arxiv.org/pdf/1812.07527)
44. [DAGs with materialized paths using Postgres ltree](https://busta.win/posts/dags-with-materialized-paths-using-postgres-ltree)
45. [Hierarchical Data Modeling (adjacency list, nested set, closure table, materialized path) — Software Patterns Lexicon](https://softwarepatternslexicon.com/sql/data-modeling-design-patterns/hierarchical-data-modeling/)
</content>
</invoke>
