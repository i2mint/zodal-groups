/**
 * The canonical model — one relation, and nothing else is authoritative.
 *
 * A `GroupSpace` holds a set of **nodes** and a set of reified **membership edges**. Every folder
 * tree, tag cloud, breadcrumb, and facet count in this library is a pure *projection* over that
 * edge set (see `./projections`). The "an item lives in exactly one place" limitation is not
 * removed here — it was never present. It is a property of one projection, and we simply stop
 * hard-coding it.
 *
 * Three modelling decisions here are load-bearing, and each cost a research report to establish:
 *
 * 1. **The node type is unified.** An item and a group are the same kind of thing; "group-ness" is
 *    *having children*, not a type. Bipartite-ness (Gmail: labels are never messages) is expressed
 *    as a *profile predicate*, not a type distinction — which is what lets one model cover both a
 *    filesystem (a directory IS a file) and a tagging system. Hence `NodeId` is branded but
 *    `ItemId`/`GroupId` are not: an item may *be* a group.
 *
 * 2. **Names and order live on the EDGE, not the node.** This is the Unix dentry / Git tree-entry
 *    insight: "names are not part of the inode but rather of the dentry". It is what makes "the
 *    same item, in two groups, under two names" representable at all, and it is why `order` is a
 *    property of the `(parent, child)` membership rather than of the child — an item in three
 *    groups needs three ranks.
 *
 * 3. **The edge is reified and carries a `kind`.** Closure semantics are a property *of the edge
 *    kind*, not of the system: SKOS deliberately makes `broader` non-transitive because mixed-kind
 *    chains lie (a wheel is `part_of` a car, a car `is_a` vehicle — a wheel is not a vehicle).
 *    Without a reified edge you also cannot represent a folksonomy, per-group ordering, or the
 *    difference between a human-asserted and a rule-inferred membership.
 *
 * @see `docs/research/_reconciliation.md` — decisions D1–D7, D18.
 */

// ── identity ────────────────────────────────────────────────────────────────

/**
 * A node identifier. Branded to prevent accidental mixing with plain strings.
 *
 * Deliberately NOT split into `ItemId` / `GroupId`: an item may itself be a group (Are.na's
 * channel-as-block; a Unix directory is a file), so group-ness is a fact about the data and the
 * active profile, not a fact about the type.
 */
export type NodeId = string & { readonly __nodeId: unique symbol };

/** An edge identifier. */
export type EdgeId = string & { readonly __edgeId: unique symbol };

/** Mint a `NodeId` from a plain string. */
export const nodeId = (s: string): NodeId => s as NodeId;

/** Mint an `EdgeId` from a plain string. */
export const edgeId = (s: string): EdgeId => s as EdgeId;

// ── edge kinds ──────────────────────────────────────────────────────────────

/**
 * The name of an edge kind, e.g. `contains`, `is_a`, `part_of`, `related`.
 *
 * The `(string & {})` union keeps the built-in names auto-completable without closing the set.
 */
export type EdgeKind = 'contains' | 'is_a' | 'part_of' | 'instance_of' | 'related' | (string & {});

/**
 * The declared semantics of an edge kind. **This is the part most tagging libraries forget**, and
 * it is what separates a toy from a thesaurus.
 *
 * Whether `poodle ⟹ dog ⟹ animal` holds is *not* answerable from the edge set alone. It is
 * answerable from the edge set plus these declarations.
 */
export interface EdgeKindDef {
  /**
   * May closure walk through this kind? SKOS's `broader` is deliberately `false`; its
   * `broaderTransitive` is `true`. Our default `contains` kind is `true`.
   */
  readonly transitive: boolean;
  /** `related` is symmetric; `contains` is not. Symmetric kinds never participate in closure. */
  readonly symmetric?: boolean;
  /** Must this kind stay acyclic? Forced `true` whenever `transitive` is `true`. */
  readonly acyclic?: boolean;
  /**
   * Relation composition, as the Gene Ontology does it: `is_a ∘ part_of → part_of`. Maps the
   * *next* edge's kind to the kind the composed path should be treated as. A missing entry means
   * the chain does not compose, and closure stops — which is exactly the mechanism that stops
   * `wheel part_of car is_a vehicle` from concluding that a wheel is a vehicle.
   */
  readonly composesWith?: Readonly<Record<string, EdgeKind>>;
  /** Kinds this one may not co-occur with. SKOS S27: `related` is disjoint from `broaderTransitive`. */
  readonly disjointWith?: readonly EdgeKind[];
}

/** The default kind: plain containment. Transitive and acyclic — the folder/tag intuition. */
export const CONTAINS: EdgeKind = 'contains';

/** Built-in edge-kind semantics, following Z39.19 (BTG/BTP/BTI + RT) and SKOS. */
export const DEFAULT_EDGE_KINDS: Readonly<Record<string, EdgeKindDef>> = Object.freeze({
  contains: { transitive: true, acyclic: true },
  is_a: { transitive: true, acyclic: true, composesWith: { is_a: 'is_a', part_of: 'part_of' } },
  part_of: { transitive: true, acyclic: true, composesWith: { part_of: 'part_of' } },
  // `instance_of` is NOT transitive: an instance of a class is not an instance of its metaclass.
  instance_of: { transitive: false, acyclic: true },
  // `related` is an associative, non-hierarchical link. It never participates in closure.
  related: { transitive: false, symmetric: true, disjointWith: ['contains', 'is_a', 'part_of'] },
});

// ── the canonical relation ──────────────────────────────────────────────────

/**
 * A reified membership edge: "`child` is in `parent`".
 *
 * Note the direction convention: `parent` is the group, `child` is the member. A `child` may itself
 * be a group (that is what makes groups-of-groups work), subject to the profile.
 */
export interface Edge {
  readonly id: EdgeId;
  /** The group. */
  readonly parent: NodeId;
  /** The member — an item, or another group. */
  readonly child: NodeId;
  /** Defaults to `contains`. Determines whether closure walks through this edge. */
  readonly kind: EdgeKind;
  /**
   * The name of the child *within this parent* (dentry-style). Optional; when absent, renderers
   * fall back to the node's own label. Present so the same item can appear under different names
   * in different groups.
   */
  readonly label?: string;
  /**
   * Rank within this parent, as a fractional-index string (see `./order`). A property of the
   * membership, not of the child — an item in three groups has three ranks.
   */
  readonly order?: string;
  /** Provenance and anything else. `assertedBy` makes a folksonomy expressible. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** A node. Its `payload` is whatever the caller's Zod schema validates — flat, never recursive. */
export interface Node<P = unknown> {
  readonly id: NodeId;
  /** A display label. May be overridden per-membership by `Edge.label`. */
  readonly label?: string;
  readonly payload?: P;
}

// ── members: literal or reference ───────────────────────────────────────────

/**
 * A member is either a **reference** to a node stored elsewhere, or a **literal value**.
 *
 * This answers a real design tension: storing `'cheese'` in a node table and then referencing it is
 * clean but silly, while forcing a 40 MB document to be a literal is absurd. Git's trick resolves
 * it — content-address the literals. With the default `IdentityStrategy`, `hash('cheese')` is just
 * `'cheese'`, so the literal case costs nothing, and the edge table stays uniform (always `NodeId`
 * on both ends). **No graph algorithm ever has to branch on this.**
 */
export type Member<V = unknown> =
  | { readonly kind: 'ref'; readonly id: NodeId }
  | { readonly kind: 'value'; readonly value: V };

/** How a literal member becomes a `NodeId`. Swap it to content-hash large values. */
export interface IdentityStrategy<V = unknown> {
  readonly idOf: (value: V) => NodeId;
}

/** The default: a string value is its own id; anything else is JSON-stringified. */
export const defaultIdentity: IdentityStrategy = {
  idOf: (value) => nodeId(typeof value === 'string' ? value : JSON.stringify(value)),
};

/** Resolve a `Member` to the `NodeId` that goes into an edge. */
export function memberId<V>(m: Member<V>, identity: IdentityStrategy<V> = defaultIdentity as IdentityStrategy<V>): NodeId {
  return m.kind === 'ref' ? m.id : identity.idOf(m.value);
}

// ── the space ───────────────────────────────────────────────────────────────

import type { GroupProfile } from './profile.js';

/**
 * The canonical state. Immutable — `applyDelta` returns a new one.
 *
 * `forward` and `inverse` are two **indexes over one relation**, not two structures. They are
 * maintained together by the single writer (`applyDelta`), which is what makes index drift
 * unrepresentable rather than merely unlikely. This is Datomic's AVET/VAET, and it is the direct
 * answer to the classic `groups_to_tags(...)` / `tags_to_groups(...)` problem: you never *convert*
 * between the two views, because there is only one relation and both views are always live.
 */
export interface GroupSpace<P = unknown> {
  readonly profile: GroupProfile;
  /** Bumped on every successful write. An O(1) memoization key for any host framework. */
  readonly revision: number;
  readonly nodes: ReadonlyMap<NodeId, Node<P>>;
  readonly edges: ReadonlyMap<EdgeId, Edge>;
  /** parent → edges out of it (its memberships). The "groups" view. */
  readonly forward: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;
  /** child → edges into it (the groups it belongs to). The "tags" view. */
  readonly inverse: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;
}

/**
 * The one and only write primitive.
 *
 * Every mutation — add to group, remove from group, re-parent, rename-in-place, reorder — is an
 * `EdgeDelta`. That makes undo free (`invert`), gives event-sourced adapters a log for free, and
 * gives Zanzibar-style change-feed consumers a stream for free.
 */
export interface EdgeDelta {
  readonly added?: readonly Edge[];
  readonly removed?: readonly EdgeId[];
  /** Nodes introduced alongside the edges (labels/payloads). Never removes nodes. */
  readonly upsertNodes?: readonly Node<unknown>[];
}

// ── results ─────────────────────────────────────────────────────────────────

/** A structured profile/invariant violation. Shaped after SHACL's validation report. */
export interface Violation {
  readonly code:
    | 'cycle'
    | 'maxDepth'
    | 'maxParentsPerItem'
    | 'maxParentsPerGroup'
    | 'maxGroupsPerItem'
    | 'groupsMayContainGroups'
    | 'groupsMayContainItems'
    | 'groupsAreItems'
    | 'unknownEdgeKind'
    | 'disjointEdgeKind'
    | 'selfEdge'
    | 'duplicateEdge';
  readonly message: string;
  readonly edge?: Edge;
  /**
   * For `cycle`: the offending path, so the UI can say *why*. Under polyhierarchy a cycle can close
   * through an off-screen branch, so a bare `false` is indistinguishable from a bug. Never omit it.
   */
  readonly path?: readonly NodeId[];
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly Violation[] };
