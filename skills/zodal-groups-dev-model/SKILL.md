---
name: zodal-groups-dev-model
description: Use when working on the zodal-groups CANONICAL MODEL or CONSTRAINT PROFILES — the keystone every other package consumes. Triggers when defining or changing Edge / Node / GroupSpace / EdgeDelta / NodeId, the GroupProfile dials (maxParentsPerItem, maxParentsPerGroup, maxDepth, groupsMayContainGroups, groupsAreItems), the named profiles (filesystem, flatTags, nestedTags, labels, polyhierarchy, taxonomy, thesaurus, folksonomy), edge KINDS and their closure semantics (transitive / composesWith / disjointWith), applyDelta, cycle enforcement, validateEdge, or the forward/inverse index pair. Also when someone proposes "just store a parent pointer" or "make Item and Group different types". Read BEFORE writing model code — the edge contract and the acyclicity invariant are easy to get wrong and expensive to change later.
metadata:
  audience: developers
---

# zodal-groups · the canonical model + profiles (the keystone)

`@zodal/groups-core` is **built and green** (54 tests). This skill maps the shipped surface and the
rules behind it. The *why* and the surveyed alternatives live in the research (routed below); this
is the procedural guide. When you touch the model, edit the shapes here in the same change.

## The thesis, in one line

> **Membership is the canonical data — a flat set of reified edges. Every folder tree, tag cloud,
> facet browser, and breadcrumb is a computed *projection* over those edges.**

The "an item lives in exactly one place" limitation was never in the data. It is a property of one
projection, and we stop hard-coding it.

## The rules this skill owns

1. **One canonical relation.** A `GroupSpace` is a set of `Node`s and a set of reified `Edge`s.
   Nothing else is authoritative. There is no separate "folders tree" and "tags map".
2. **`forward` and `inverse` are two INDEXES over one relation**, written together by the single
   writer (`applyDelta`). This makes index drift *unrepresentable*, and it is the direct answer to
   the classic `groups_to_tags()` / `tags_to_groups()` problem: you never *convert*, because both
   views are always live. (Datomic's AVET/VAET.)
3. **Names and order live on the EDGE, not the node.** Unix dentry / Git tree-entry. This is what
   makes "the same item, in two groups, under two names, in two positions" representable at all.
4. **The edge carries a `kind`, and closure semantics belong to the KIND.** Not to the system. See
   the wheel/car/vehicle rule below — this is the single most-forgotten thing in the field.
5. **Unified node type.** An item and a group are the same thing; group-ness is *having children*.
   Bipartite-ness is a **profile predicate**, never a type distinction.
6. **Brand `NodeId` only.** Never `ItemId` vs `GroupId` — an item may *be* a group.
7. **`EdgeDelta` is the ONLY write primitive.** Undo is `invert(delta)`; a change-feed is free.
8. **Acyclic on WRITE; cycle-safe on READ.** Both. See below — this is not belt-and-braces.
9. **A profile is a runtime VALIDATOR first.** Type-level narrowing is a bonus on top, never the
   foundation: edges arrive from adapters and imports that never heard of the profile.

## The shapes (from `packages/groups-core/src/model.ts`)

```ts
type NodeId = string & { readonly __nodeId: unique symbol };   // branded. NOT ItemId/GroupId.

interface Edge {
  readonly id: EdgeId;
  readonly parent: NodeId;      // the group
  readonly child: NodeId;       // an item OR another group
  readonly kind: EdgeKind;      // 'contains' | 'is_a' | 'part_of' | 'instance_of' | 'related' | …
  readonly label?: string;      // the name of the child WITHIN THIS PARENT (dentry-style)
  readonly order?: string;      // fractional index — a rank per (group, item), not per item
  readonly meta?: Readonly<Record<string, unknown>>;   // provenance: `assertedBy` ⇒ folksonomy
}

interface GroupSpace<P = unknown> {
  readonly profile: GroupProfile;
  readonly revision: number;    // O(1) memoization key for ANY host framework
  readonly nodes: ReadonlyMap<NodeId, Node<P>>;
  readonly edges: ReadonlyMap<EdgeId, Edge>;
  readonly forward: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;  // group → its members  ("groups" view)
  readonly inverse: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;  // node  → its groups   ("tags"  view)
}

interface EdgeDelta {                          // the ONE write primitive
  readonly added?: readonly Edge[];
  readonly removed?: readonly EdgeId[];
  readonly upsertNodes?: readonly Node<unknown>[];
}

applyDelta(space, delta): Result<GroupSpace>   // validates profile + acyclicity, all-or-nothing
invert(space, delta): EdgeDelta                // undo, for free
```

## Edge kinds — the rule everyone forgets

**Closure semantics are a property of the edge KIND, not of the system.** Walking every edge blindly
produces false conclusions:

> A *wheel* is `part_of` a *car*. A *car* `is_a` *vehicle*. **A wheel is not a vehicle.**

This is why SKOS makes `skos:broader` deliberately **non-transitive**, and why the Gene Ontology only
earns transitivity by declaring composition rules (`is_a ∘ part_of → part_of`) and *excluding* the
unsafe combinations.

```ts
interface EdgeKindDef {
  readonly transitive: boolean;                          // may closure walk through this?
  readonly symmetric?: boolean;                          // `related` is; `contains` isn't
  readonly acyclic?: boolean;                            // forced true when transitive
  readonly composesWith?: Record<string, EdgeKind>;      // GO: is_a ∘ part_of → part_of
  readonly disjointWith?: readonly EdgeKind[];           // SKOS S27: related ⊥ broaderTransitive
}
```

**When `composesWith` is absent, a chain only continues through the *same* kind.** That is the
conservative reading, and it is what stops the wheel from becoming a vehicle. Do not "fix" it.

## Acyclic on write, cycle-safe on read — and why it's both

- **Write path:** `applyDelta` refuses any delta that would close a cycle. There is **no
  `allowCycles` flag.** Cycles kill closure, refcounting, and termination.
- **Read path:** every projection is *nevertheless* cycle-safe. `PathNode.isRecursive` is **not
  optional**; every traversal memoizes and guards.

This is not paranoia. **`zodal-groups` does not own its data.** Edges arrive from store adapters,
imports, and foreign systems that never heard of our invariant — and real taxonomies *do* contain
cycles (the ODP study; Wikipedia's category graph). A projection that assumes acyclicity is a
projection that hangs the browser on someone else's bad data.

**Cycle errors must carry the offending path.** Under polyhierarchy a cycle can close through a
branch the user cannot see, so a bare `false` is indistinguishable from a bug:

```ts
{ code: 'cycle', path: ['reading','research','archive','reading'],
  message: 'Adding archive to reading would create a cycle: reading → research → archive → reading.' }
```

## The profiles — one model, named restrictions, each buying a guarantee

Framing borrowed from **OWL 2 Profiles**; report shape from **SHACL** (whose `sh:maxCount` on a
`broader` path is literally our `maxParentsPerGroup`); the ladder is **Z39.19**'s, from 2005.

| profile | dials | covers |
|---|---|---|
| `filesystem` | `maxParentsPerItem: 1, maxParentsPerGroup: 1` | folders & subfolders |
| `flatTags` | `maxDepth: 0, groupsMayContainGroups: false` | tags, no tagging-of-tags |
| `nestedTags` | `maxParentsPerGroup: 1` | Obsidian/Bear — *but with real edges* |
| `labels` | `maxParentsPerItem: null, maxParentsPerGroup: 1` | **Gmail** |
| `polyhierarchy` | defaults, acyclic | the general case |
| `taxonomy` | `groupsMayContainItems: false` | a classification skeleton |
| `thesaurus` | typed `edgeKinds` | Z39.19 / SKOS |
| `folksonomy` | `flatTags` + per-user edges | the `(tag, object, identity)` triple |

**⚠️ `maxDepth` counts GROUP nesting, not distance from a root.** Filing an item into a group adds
no depth — otherwise `maxDepth: 0` (flat tagging) would forbid tagging anything at all, which is the
opposite of what it means. This is a bug I already shipped once; the test is
`profiles.test.ts › enforces a max GROUP-nesting depth`.

## Adding a new dial

1. Add the field to `GroupProfile` (`profile.ts`) with a sensible default in `BASE`.
2. Add a `Violation['code']` for it in `model.ts`.
3. Enforce it in `validateEdge` (`space.ts`) — and **give the message something the user can act
   on**, not just "invalid".
4. Add it to a named profile if it defines one, and to the table above.
5. Test both directions: it accepts what it should, and rejects what it should *with the right code*.

## Do NOT

- ❌ **Composite as the canonical model.** Its GoF intent literally says *tree*. Under a DAG the
  `parent` pointer is ill-typed, recursion double-counts and can go exponential, and path ≠ identity.
  (Composite is fine as the *output* of `projectTree` — where it finally fits.)
- ❌ **A `node.parent` accessor with an arbitrary "primary parent".** That is exactly the `..`
  ambiguity Unix refused to ship, and it is a lie that leaks into every breadcrumb. If you want one
  route, call `primaryPath()` — so the choice is visible at the call site.
- ❌ **Modelling the graph as a recursive Zod schema (`z.lazy`).** Zod's own docs: "passing cyclical
  data into Zod will cause an infinite loop"; recursive inference "is finicky"; TS 5.9+ breaks it
  (`TS2615`). **Validate flat `nodes[]` + `edges[]`** and enforce structure with `validateProfile`.
- ❌ **Materialized path or nested sets as the canonical encoding.** Nested set is *structurally
  incapable* of multi-parent (one interval = one position = one parent). Materialized path fails
  *combinatorially* (distinct root-paths in a DAG are exponential in depth).
- ❌ **Two structures kept in sync by an Observer.** That *is* index drift, waiting.
- ❌ **Calling this CQRS.** CQRS's defining property is *eventual* consistency; ours is synchronous.

## Routing

- The decisions, with evidence: [`docs/research/_reconciliation.md`](../../docs/research/_reconciliation.md) — **read this first**
- Classification theory, SKOS/Z39.19, edge kinds: `docs/research/zgroups_01-*`
- Storage encodings, closure strategy: `docs/research/zgroups_02-*`
- Patterns, Datomic/Git/VFS/Zanzibar: `docs/research/zgroups_05-*`
