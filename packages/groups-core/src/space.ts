/**
 * The space: index maintenance, the single write primitive, and invariant enforcement.
 *
 * `applyDelta` is the *only* way to change a `GroupSpace`. It validates the delta against the
 * profile, refuses cycles (reporting the offending path, never a bare boolean), updates the forward
 * and inverse indexes together, and bumps `revision`.
 *
 * Because both indexes are written in the same operation by the same writer, index drift — the
 * classic failure of keeping a "folders tree" and a "tags map" in sync with an observer — is not
 * merely unlikely here; it is unrepresentable. There is one relation. `forward` and `inverse` are
 * two views of it, and both are always live.
 *
 * Nodes are deleted through the same primitive: `EdgeDelta.removedNodes` carries **tombstones**
 * (the full node), so `invert` restores a deleted group with its label, payload and edges.
 *
 * @see `docs/research/_reconciliation.md` — decisions D2, D7, D8, D15, D25, D26.
 */

import {
  edgeId,
  type Edge,
  type EdgeDelta,
  type EdgeKind,
  type EdgeId,
  type GroupSpace,
  type Node,
  type NodeId,
  type Result,
  type Violation,
  CONTAINS,
} from './model.js';
import { resolveProfile, type GroupProfile, type ProfileName } from './profile.js';
import { familyViolations, hasFamilyAtOrAbove } from './family.js';
import { edgeProblem, isFamilyRule, nodeProblem, safe, sameValue } from './structure.js';
import { compareOrder, orderBetween } from './order.js';

// ── construction ────────────────────────────────────────────────────────────

export interface CreateSpaceOptions<P> {
  readonly profile?: ProfileName | GroupProfile;
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  readonly nodes?: readonly Node<P>[];
  readonly edges?: readonly Edge[];
}

/** An empty space under the given profile. */
export function createGroupSpace<P = unknown>(options: CreateSpaceOptions<P> = {}): GroupSpace<P> {
  const profile = resolveProfile(options.profile, options.overrides);
  const empty: GroupSpace<P> = {
    profile,
    revision: 0,
    nodes: new Map(),
    edges: new Map(),
    forward: new Map(),
    inverse: new Map(),
  };
  if (!options.nodes?.length && !options.edges?.length) return empty;

  const seeded = applyDelta(empty, {
    upsertNodes: options.nodes,
    added: options.edges,
  });
  if (!seeded.ok) {
    throw new Error(
      `Seed data violates profile '${profile.name}':\n` +
        seeded.violations.map((v) => `  - [${v.code}] ${v.message}`).join('\n'),
    );
  }
  return seeded.value;
}

// ── index helpers ───────────────────────────────────────────────────────────

/** Where `stageDelta` writes: eager copies (`applyDelta`, which returns them) or copy-on-write views. */
interface StagingMap<K, V> extends ReadonlyMap<K, V> {
  set(key: K, value: V): unknown;
  delete(key: K): unknown;
  toMap(): ReadonlyMap<K, V>;
}
interface StagingIndex extends ReadonlyMap<NodeId, ReadonlySet<EdgeId>> {
  add(key: NodeId, id: EdgeId): void;
  remove(key: NodeId, id: EdgeId): void;
  toMap(): ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;
}

/** A full copy, written in place: what `applyDelta` stages into, since it returns the copy anyway. */
class EagerMap<K, V> extends Map<K, V> implements StagingMap<K, V> {
  toMap(): Map<K, V> {
    return this;
  }
}

class EagerIndex extends Map<NodeId, Set<EdgeId>> implements StagingIndex {
  constructor(src: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>) {
    super();
    for (const [k, v] of src) super.set(k, new Set(v));
  }
  add(key: NodeId, id: EdgeId): void {
    const existing = this.get(key);
    if (existing) existing.add(id);
    else this.set(key, new Set([id]));
  }
  remove(key: NodeId, id: EdgeId): void {
    const existing = this.get(key);
    if (!existing) return;
    existing.delete(id);
    if (existing.size === 0) this.delete(key);
  }
  toMap(): Map<NodeId, Set<EdgeId>> {
    return this;
  }
}

const GONE: unique symbol = Symbol('gone');

/**
 * A copy-on-write view of a map: writes land in an overlay and the base is never touched, so
 * staging a delta costs O(the delta), not O(the space). `toMap()` materializes the result.
 */
class CowMap<K, V> implements StagingMap<K, V> {
  protected readonly changed = new Map<K, V | typeof GONE>();
  /** Base keys deleted and set again: they iterate after the base, in `changed`'s order. */
  private readonly reinserted = new Set<K>();
  constructor(protected readonly base: ReadonlyMap<K, V>) {}

  get(key: K): V | undefined {
    if (!this.changed.has(key)) return this.base.get(key);
    const v = this.changed.get(key)!;
    return v === GONE ? undefined : v;
  }
  has(key: K): boolean {
    return this.changed.has(key) ? this.changed.get(key) !== GONE : this.base.has(key);
  }
  set(key: K, value: V): void {
    // A deleted base key comes back at the END, as in a real Map (iteration order reaches
    // violation order and messages, which must match `applyDelta`'s).
    if (this.changed.get(key) === GONE) {
      this.changed.delete(key);
      this.reinserted.add(key);
    }
    this.changed.set(key, value);
  }
  delete(key: K): void {
    if (this.base.has(key)) this.changed.set(key, GONE);
    else this.changed.delete(key);
  }
  get size(): number {
    let size = this.base.size;
    for (const [k, v] of this.changed) {
      const inBase = this.base.has(k);
      if (v === GONE) size -= 1;
      else if (!inBase) size += 1;
    }
    return size;
  }
  *entries(): MapIterator<[K, V]> {
    for (const [k, v] of this.base) {
      if (!this.changed.has(k)) yield [k, v];
      else if (!this.reinserted.has(k)) {
        const c = this.changed.get(k)!;
        if (c !== GONE) yield [k, c];
      }
    }
    for (const [k, c] of this.changed) if (c !== GONE && (!this.base.has(k) || this.reinserted.has(k))) yield [k, c];
  }
  *keys(): MapIterator<K> {
    for (const [k] of this.entries()) yield k;
  }
  *values(): MapIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void {
    for (const [k, v] of this.entries()) fn(v, k, this);
  }
  toMap(): Map<K, V> {
    const out = new Map(this.base);
    for (const [k, v] of this.changed) {
      if (v === GONE) out.delete(k);
      else out.set(k, v);
    }
    return out;
  }
}

/**
 * A set seen through the edits made to it: nothing is copied until `toSet()`. It has the read
 * surface the space's code uses (`has`, `size`, iteration, `forEach`), not the ES2025 set algebra
 * (`union`, …), so it does not claim `ReadonlySet`: `CowIndex` casts it at the one place it enters.
 */
class SetOverlay<T> implements Iterable<T> {
  private readonly added = new Set<T>();
  private readonly removed = new Set<T>();
  constructor(private readonly base: ReadonlySet<T> = new Set()) {}

  add(value: T): void {
    // A removed base member stays hidden there and comes back at the END, as in a real Set.
    if (this.base.has(value) && !this.removed.has(value)) return;
    this.added.add(value);
  }
  delete(value: T): void {
    if (this.added.delete(value)) return;
    if (this.base.has(value)) this.removed.add(value);
  }
  has(value: T): boolean {
    return this.added.has(value) || (this.base.has(value) && !this.removed.has(value));
  }
  get size(): number {
    return this.base.size - this.removed.size + this.added.size;
  }
  *values(): SetIterator<T> {
    for (const v of this.base) if (!this.removed.has(v)) yield v;
    yield* this.added;
  }
  keys(): SetIterator<T> {
    return this.values();
  }
  *entries(): SetIterator<[T, T]> {
    for (const v of this.values()) yield [v, v];
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }
  forEach(fn: (value: T, value2: T, set: SetOverlay<T>) => void): void {
    for (const v of this.values()) fn(v, v, this);
  }
  /** The edited set; the base itself when nothing changed, so an untouched key shares its set. */
  toSet(): ReadonlySet<T> {
    if (!this.added.size && !this.removed.size) return this.base;
    if (!this.base.size) return this.added;
    const out = new Set(this.base);
    for (const v of this.removed) out.delete(v);
    for (const v of this.added) out.add(v);
    return out;
  }
}

/**
 * A copy-on-write index (`forward` / `inverse`). A written key's set is an overlay of its edits,
 * so removing one member from a 20k-member group copies nothing until the space is materialized.
 * Sets the base holds are never mutated: a materialized index shares the untouched ones.
 */
class CowIndex extends CowMap<NodeId, ReadonlySet<EdgeId>> implements StagingIndex {
  private writable(key: NodeId): SetOverlay<EdgeId> {
    const current: unknown = this.get(key);
    if (current instanceof SetOverlay) return current as SetOverlay<EdgeId>;
    const overlay = new SetOverlay(current as ReadonlySet<EdgeId> | undefined);
    this.set(key, overlay as unknown as ReadonlySet<EdgeId>);
    return overlay;
  }
  add(key: NodeId, id: EdgeId): void {
    this.writable(key).add(id);
  }
  remove(key: NodeId, id: EdgeId): void {
    if (!this.get(key)?.has(id)) return;
    const ids = this.writable(key);
    ids.delete(id);
    if (ids.size === 0) this.delete(key);
  }
  override toMap(): Map<NodeId, ReadonlySet<EdgeId>> {
    const out = super.toMap();
    for (const [k, v] of this.changed) if ((v as unknown) instanceof SetOverlay) out.set(k, (v as unknown as SetOverlay<EdgeId>).toSet());
    return out;
  }
}

// ── reads over the indexes (the two live views) ─────────────────────────────

/** The edges out of a group — its memberships. The **groups** view. */
export function edgesOf(space: GroupSpace, parent: NodeId): Edge[] {
  const ids = space.forward.get(parent);
  if (!ids) return [];
  return [...ids].map((id) => space.edges.get(id)!).filter(Boolean);
}

/** The edges into a node — the groups it belongs to. The **tags** view. */
export function edgesInto(space: GroupSpace, child: NodeId): Edge[] {
  const ids = space.inverse.get(child);
  if (!ids) return [];
  return [...ids].map((id) => space.edges.get(id)!).filter(Boolean);
}

/** Direct members of a group. */
export const childrenOf = (space: GroupSpace, parent: NodeId): NodeId[] =>
  edgesOf(space, parent).map((e) => e.child);

/**
 * The groups a node is directly in.
 *
 * There is deliberately no `parentOf()` returning a single value: an arbitrary "primary parent" is
 * exactly the `..` ambiguity Unix refused, and it is a lie that leaks into every breadcrumb. Where
 * a single path is genuinely needed (a URL, a deep link), ask for it explicitly via
 * `primaryPath()` — which makes the choice visible.
 */
export const parentsOf = (space: GroupSpace, child: NodeId): NodeId[] =>
  edgesInto(space, child).map((e) => e.parent);

/**
 * The canonical name of `id`: follow its `alias_of` edge (or `kind`'s) to the node it names, and
 * on through a chain (`a → b → c` resolves to `c`, as Hydrus collapses sibling chains). A node that
 * is no alias resolves to itself. Facades call this on write (`tag(ids, 'to-do')` records `todo`)
 * and search UIs on read; `applyDelta` never does (D7). Cycle-safe for foreign data: a cycle
 * resolves to the last node before it repeats.
 */
export function resolveAlias(space: GroupSpace, id: NodeId, kind: EdgeKind = 'alias_of'): NodeId {
  const seen = new Set<NodeId>([id]);
  let current = id;
  for (;;) {
    const next = edgesInto(space, current).find((e) => e.kind === kind)?.parent;
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * Is this edge kind a **membership** (hierarchical) kind? Its declared `membership`, defaulting to
 * `!symmetric` (D30). Undeclared kinds (foreign data) count as membership, the conservative reading
 * for projections.
 *
 * Not "transitive": `instance_of` is non-transitive yet hierarchical (Z39.19's BTI) — a class with
 * instances is a group of them.
 */
export function isMembershipKind(profile: GroupProfile, kind: string): boolean {
  const def = profile.edgeKinds[kind];
  return def?.membership ?? def?.symmetric !== true;
}

/**
 * A node is a *group* iff something is in it — through a membership kind. Group-ness is data, not
 * type; an associative link (`related`) makes nobody a group.
 */
export function isGroup(space: GroupSpace, id: NodeId): boolean {
  const out = space.forward.get(id);
  if (!out) return false;
  for (const edgeId of out) {
    const edge = space.edges.get(edgeId);
    if (edge && isMembershipKind(space.profile, edge.kind)) return true;
  }
  return false;
}

/** How many groups a node is directly in — membership kinds only (a `related` link is no parent). */
export function membershipParentCount(space: GroupSpace, id: NodeId): number {
  let count = 0;
  for (const edgeId of space.inverse.get(id) ?? []) {
    const edge = space.edges.get(edgeId);
    if (edge && isMembershipKind(space.profile, edge.kind)) count += 1;
  }
  return count;
}

/**
 * Is `id` only another name for a node: the child of an `alias_of` (or `kind`) edge, with no members
 * of its own? Such a node is reached through its canonical node, so `rootsOf`, `orphansOf` and the
 * browse projections leave it out (D35); `resolveAlias` maps it on read and write. An alias that
 * still has members (data written before its alias edge) is a group, and stays visible.
 */
export function isAliasName(space: GroupSpace, id: NodeId, kind: EdgeKind = 'alias_of'): boolean {
  return !isGroup(space, id) && edgesInto(space, id).some((e) => e.kind === kind);
}

/** Nodes in no group — no incoming membership edge (a `related` or `alias_of` link is no parent),
 *  aliases left out (D35). The semantic entry points; the browse projections use `browseRootsOf`. */
export function rootsOf(space: GroupSpace): NodeId[] {
  return [...space.nodes.keys()].filter((id) => membershipParentCount(space, id) === 0 && !isAliasName(space, id));
}

/** Items in no group at all — Zotero's "Unfiled Items". A group is never unfiled, nor an alias. */
export const orphansOf = (space: GroupSpace): NodeId[] =>
  rootsOf(space).filter((id) => !isGroup(space, id));

/** Does a browse projection (tree, columns, facets) walk this edge? Only transitive kinds (D35). */
export const isWalkedEdge = (space: GroupSpace, edge: Edge): boolean =>
  space.profile.edgeKinds[edge.kind]?.transitive === true;

/** How many edges a browse projection walks out of `id`: what its expander opens to (D35). */
export const walkedChildCount = (space: GroupSpace, id: NodeId): number =>
  edgesOf(space, id).filter((e) => isWalkedEdge(space, e)).length;

/** How many edges a browse projection walks into `id`: how many places it shows up in (D35). */
export const walkedParentCount = (space: GroupSpace, id: NodeId): number =>
  edgesInto(space, id).filter((e) => isWalkedEdge(space, e)).length;

/**
 * Where the browse projections start: nodes no walked edge leads to, aliases left out (D35). A
 * node reached only through a non-transitive kind (`instance_of`, `related`, a foreign kind) is a
 * root here, or it would be unreachable; `rootsOf` is the semantic reading.
 */
export function browseRootsOf(space: GroupSpace): NodeId[] {
  return [...space.nodes.keys()].filter((id) => walkedParentCount(space, id) === 0 && !isAliasName(space, id));
}

// ── cycle detection ─────────────────────────────────────────────────────────

/**
 * Would adding `parent → child` close a cycle? Returns the offending path if so, else `null`.
 *
 * Returning the *path* rather than a boolean is not a nicety. Under polyhierarchy a cycle can close
 * through a branch the user cannot see, so "you can't drop that here" with no explanation is
 * indistinguishable from a bug. With the path, the UI can say: *"Reading is already inside
 * Archive → Research → Reading."*
 */
export function findCycle(space: GroupSpace, parent: NodeId, child: NodeId): NodeId[] | null {
  if (parent === child) return [parent, child];
  // A cycle appears iff `parent` is already reachable from `child` by walking downwards.
  const stack: Array<{ node: NodeId; path: NodeId[] }> = [{ node: child, path: [child] }];
  const seen = new Set<NodeId>([child]);

  while (stack.length) {
    const { node, path } = stack.pop()!;
    for (const edge of edgesOf(space, node)) {
      if (!isAcyclicKind(space.profile, edge.kind)) continue;
      const next = edge.child;
      if (next === parent) return [...path, parent];
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push({ node: next, path: [...path, next] });
    }
  }
  return null;
}

/**
 * Must edges of this kind stay out of cycles? Every kind that is transitive OR declared acyclic.
 * They form ONE acyclic order together: a cycle closed through a mix of them (`a ⊃instance_of d`,
 * `d ⊃is_a a`) is still a cycle. Walking only the transitive kinds made the check depend on edge
 * order — and a state reached one way then blocked its own undo forever.
 */
export function isAcyclicKind(profile: GroupProfile, kind: string): boolean {
  const def = profile.edgeKinds[kind];
  return Boolean(def && (def.transitive || def.acyclic));
}

function isTransitiveKind(profile: GroupProfile, kind: string): boolean {
  return profile.edgeKinds[kind]?.transitive ?? false;
}

/**
 * Depth of the deepest chain of *group-in-group* nesting below `node`. Cycle-safe.
 *
 * Only edges whose child is itself a group count. `maxDepth` measures how deeply the **group
 * hierarchy** nests, not how far an item sits from a root — otherwise `maxDepth: 0` (flat tagging)
 * would forbid tagging an item at all, which is the opposite of what it means.
 */
function groupDepthBelow(
  space: GroupSpace,
  node: NodeId,
  groupNess: GroupPredicate,
  seen = new Set<NodeId>(),
): number {
  if (seen.has(node)) return 0;
  seen.add(node);
  let deepest = 0;
  for (const edge of edgesOf(space, node)) {
    if (!isTransitiveKind(space.profile, edge.kind)) continue;
    if (!groupNess(edge.child)) continue; // an item is not a level of nesting
    deepest = Math.max(deepest, 1 + groupDepthBelow(space, edge.child, groupNess, seen));
  }
  seen.delete(node);
  return deepest;
}

/**
 * Depth of the longest chain of nesting above `node`. Cycle-safe.
 *
 * Every node above a group is itself a group (it has children, by definition), so every edge in an
 * upward chain is group-in-group nesting and counts.
 */
function depthAbove(space: GroupSpace, node: NodeId, seen = new Set<NodeId>()): number {
  if (seen.has(node)) return 0;
  seen.add(node);
  let deepest = 0;
  for (const edge of edgesInto(space, node)) {
    if (!isTransitiveKind(space.profile, edge.kind)) continue;
    deepest = Math.max(deepest, 1 + depthAbove(space, edge.parent, seen));
  }
  seen.delete(node);
  return deepest;
}

/** "Is this node a group?" — judged against some state (the current one, or a delta's end state). */
type GroupPredicate = (id: NodeId) => boolean;

// ── the write primitive ─────────────────────────────────────────────────────

let edgeCounter = 0;

/** Build an edge, minting an id if none is supplied. */
export function makeEdge(parent: NodeId, child: NodeId, init: Partial<Omit<Edge, 'parent' | 'child'>> = {}): Edge {
  return {
    id: init.id ?? edgeId(`e${++edgeCounter}:${parent}>${child}`),
    parent,
    child,
    kind: init.kind ?? CONTAINS,
    ...(init.label !== undefined ? { label: init.label } : {}),
    ...(init.order !== undefined ? { order: init.order } : {}),
    ...(init.meta !== undefined ? { meta: init.meta } : {}),
  };
}

/**
 * Merge a node patch into an existing node. A field set to `undefined` is *cleared*, which keeps a
 * merge invertible (see `invert`) and matches what a JSON round-trip does anyway.
 */
function mergeNode<P>(existing: Node<P> | undefined, patch: Node<unknown>): Node<P> {
  const merged: Record<string, unknown> = { ...(existing ?? {}), ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as Node<P>;
}

/**
 * Apply a delta. The only mutation path.
 *
 * Validation is all-or-nothing: if any edge in the delta violates the profile, nothing is applied
 * and every violation is reported. Partial application would leave the caller unable to reason
 * about what happened.
 *
 * Order of operations: node upserts, edge removals, edge additions (each validated), node removals
 * (each must leave no edge behind), then the per-family cardinality rules over the items the delta
 * touched. Whether an edge's child "is a group" is judged against the delta's **end state**, so the
 * order of `added` never matters: an edge into a node that this same delta makes a parent is an edge
 * into a group. (Without that, re-adding a deleted group's edges — an undo — could fail under a
 * profile that treats items and groups differently, depending on which edge came first.)
 *
 * **Cost.** Checking one added edge costs O(the child's parents) plus a closure walk where the
 * profile needs one — never O(the group's members), so tagging 20k items in one delta is linear.
 * But every accepted call copies the space's four maps (it returns a new immutable space): O(N)
 * per call. So apply a bulk change as ONE delta; N single-edge calls cost O(N²). A store that holds
 * a large membership relation should not route it through an in-memory `GroupSpace` at all (D10).
 * To only ask whether a delta would pass, call `canApply`: it runs the same checks without the copy.
 */
export function applyDelta<P>(space: GroupSpace<P>, delta: EdgeDelta): Result<GroupSpace<P>> {
  const { violations, staged } = stageDelta(space, delta, eagerStaging(space));
  if (violations.length) return { ok: false, violations };
  return {
    ok: true,
    value: {
      ...space,
      revision: space.revision + 1,
      nodes: staged.nodes.toMap(),
      edges: staged.edges.toMap(),
      forward: staged.forward.toMap(),
      inverse: staged.inverse.toMap(),
    },
  };
}

/**
 * The violations `applyDelta(space, delta)` would report — empty when it would succeed — without
 * building the new space: O(the delta) plus the checks, never O(the space). A drag target, a
 * preflight or a "would this pass?" probe calls this rather than applying and discarding.
 */
export function canApply<P>(space: GroupSpace<P>, delta: EdgeDelta): Violation[] {
  const staging: Staged<P> = {
    nodes: new CowMap(space.nodes),
    edges: new CowMap(space.edges),
    forward: new CowIndex(space.forward),
    inverse: new CowIndex(space.inverse),
  };
  return stageDelta(space, delta, staging).violations;
}

interface Staged<P> {
  readonly nodes: StagingMap<NodeId, Node<P>>;
  readonly edges: StagingMap<EdgeId, Edge>;
  readonly forward: StagingIndex;
  readonly inverse: StagingIndex;
}

function eagerStaging<P>(space: GroupSpace<P>): Staged<P> {
  return {
    nodes: new EagerMap(space.nodes),
    edges: new EagerMap(space.edges),
    forward: new EagerIndex(space.forward),
    inverse: new EagerIndex(space.inverse),
  };
}

/**
 * `applyDelta`'s checks, written into `staging`: the one validation path. `applyDelta` stages into
 * eager copies (the space it returns); `canApply` into copy-on-write views, so it copies nothing.
 */
function stageDelta<P>(space: GroupSpace<P>, delta: EdgeDelta, staging: Staged<P>): { violations: Violation[]; staged: Staged<P> } {
  const { nodes, edges, forward, inverse } = staging;

  // Structure first: anything accepted here must load back from a snapshot (see `structure.ts`).
  const violations: Violation[] = [];
  const structurallyValid = (node: Node<unknown>): boolean => {
    const family = (node as { family?: unknown }).family;
    if (family !== undefined && !isFamilyRule(family)) {
      violations.push({
        code: 'invalidFamilyRule',
        node: node.id,
        message: `${node.id}: a family rule must be { maxPerItem: an integer ≥ 1 }, got ${safe(family)}.`,
      });
      return false;
    }
    const problem = nodeProblem(node);
    if (problem) {
      violations.push({ code: 'malformed', node: node.id, message: `Node ${safe(node.id)} is malformed — ${problem}.` });
      return false;
    }
    return true;
  };

  // Creations: refused if the id is live — a create never merges into someone else's node.
  for (const node of delta.addedNodes ?? []) {
    if (!structurallyValid(node)) continue;
    if (nodes.has(node.id)) {
      violations.push({
        code: 'nodeExists',
        node: node.id,
        message: `Cannot create ${node.id}: a node with that id exists (it was created or changed since this delta was made).`,
      });
      continue;
    }
    nodes.set(node.id, mergeNode(undefined, node));
  }

  for (const node of delta.upsertNodes ?? []) {
    if (structurallyValid(node)) nodes.set(node.id, mergeNode(nodes.get(node.id), node));
  }

  // Removals first: a re-parent is (remove old, add new), and doing it in this order means the old
  // edge never counts against `maxParents` when the new one is validated.
  const unlink = (id: EdgeId): void => {
    const edge = edges.get(id);
    if (!edge) return;
    edges.delete(id);
    forward.remove(edge.parent, id);
    inverse.remove(edge.child, id);
  };
  for (const id of delta.removed ?? []) unlink(id);

  const staged: GroupSpace<P> = { ...space, nodes, edges, forward, inverse };
  const added = delta.added ?? [];
  const futureGroups = new Set(added.filter((e) => isMembershipKind(space.profile, e.kind)).map((e) => e.parent));
  const groupNess: GroupPredicate = (id) => isGroup(staged, id) || futureGroups.has(id);
  const becomingReported = new Set<NodeId>();

  for (const edge of added) {
    const problem = edgeProblem(edge);
    if (problem) {
      violations.push({ code: 'malformed', edge, message: `Edge ${safe(edge?.id)} is malformed — ${problem}.` });
      continue;
    }
    // A live edge id is never silently replaced (that is how a stale undo would overwrite a newer
    // edge); to replace one, remove it in the same delta — removals run first.
    if (edges.has(edge.id)) {
      violations.push({
        code: 'edgeIdExists',
        edge,
        message: `Edge id ${edge.id} is already in use; remove it in the same delta to replace it.`,
      });
      continue;
    }
    const v = checkEdge(staged, edge, groupNess, becomingReported);
    if (v.length) {
      violations.push(...v);
      continue;
    }
    // Auto-create referenced nodes so the simple path stays simple.
    if (!nodes.has(edge.parent)) nodes.set(edge.parent, { id: edge.parent } as Node<P>);
    if (!nodes.has(edge.child)) nodes.set(edge.child, { id: edge.child } as Node<P>);

    edges.set(edge.id, edge);
    forward.add(edge.parent, edge.id);
    inverse.add(edge.child, edge.id);
  }

  // Tombstones: a node may only go once nothing points at it — the delta must say what happens to
  // its edges, so that the delta alone is enough to undo it.
  for (const node of delta.removedNodes ?? []) {
    const live = nodes.get(node.id);
    if (!live) continue;
    if (!sameValue(live, node)) {
      violations.push({
        code: 'staleTombstone',
        node: node.id,
        message: `Cannot remove ${node.id}: it changed since this delta was made (tombstone ${safe(node)}, live ${safe(live)}).`,
      });
      continue;
    }
    const touching = [...(forward.get(node.id) ?? []), ...(inverse.get(node.id) ?? [])];
    if (touching.length) {
      violations.push({
        code: 'danglingEdge',
        node: node.id,
        message: `Cannot remove ${node.id}: ${touching.length} edge(s) still touch it (${touching.join(', ')}). Remove them in the same delta — deleteNodeDelta() builds one.`,
      });
      continue;
    }
    nodes.delete(node.id);
  }

  // A group that lost its last member is an ITEM now, and its memberships are an item's: hold them
  // to the item rules (the mirror image of "becoming a group" in `checkEdge`).
  const becameItems: NodeId[] = [];
  if (!violations.length) {
    const lostMembers = new Set<NodeId>();
    for (const id of delta.removed ?? []) {
      const edge = space.edges.get(id);
      if (edge) lostMembers.add(edge.parent);
    }
    for (const id of lostMembers) {
      if (!nodes.has(id) || !isGroup(space, id) || isGroup(staged, id)) continue;
      becameItems.push(id);
      violations.push(...itemRuleViolations(staged, id));
    }
  }

  // Per-family cardinality is a property of the END state (which values an item falls under), so it
  // is checked once the structure is known to be sound.
  if (!violations.length) violations.push(...familyViolations(staged, delta, becameItems));

  return { violations, staged: staging };
}

/**
 * Check one edge against the profile and the acyclicity invariant, in the context of a space that
 * already has the delta's removals applied.
 *
 * Per-family cardinality (`Node.family`) is not checked here — it depends on the state *after* the
 * edge lands. `canAddTo` and `applyDelta` check it.
 */
export function validateEdge<P>(space: GroupSpace<P>, edge: Edge): Violation[] {
  return checkEdge(space, edge, (id) => isGroup(space, id));
}

// A new rule here must also be reflected in `mayRefusePlainItems` and `mayRefuseEmptying` (their
// property tests in `tests/plain-items.test.ts` catch a rule they miss only if random spaces hit it).
function checkEdge<P>(
  space: GroupSpace<P>,
  edge: Edge,
  groupNess: GroupPredicate,
  /** Parents already reported as breaking the group rules by becoming a group, in this delta. */
  becomingReported: Set<NodeId> = new Set(),
): Violation[] {
  const p = space.profile;
  const out: Violation[] = [];

  if (edge.parent === edge.child) {
    out.push({ code: 'selfEdge', message: `A node cannot contain itself: ${edge.child}.`, edge });
    return out;
  }

  const kindDef = p.edgeKinds[edge.kind];
  if (!kindDef) {
    out.push({
      code: 'unknownEdgeKind',
      message: `Edge kind '${edge.kind}' is not declared in profile '${p.name}'. Declared kinds: ${Object.keys(p.edgeKinds).join(', ')}.`,
      edge,
    });
    return out;
  }

  // The edges already linking this parent to this child. Read from the CHILD's side: a child has
  // few parents, while a group may have millions of members — listing the group per added edge
  // made bulk tagging quadratic.
  const between = edgesInto(space, edge.child).filter((e) => e.parent === edge.parent && e.id !== edge.id);

  // Duplicate (same parent, child, kind).
  const duplicate = between.some((e) => e.kind === edge.kind);
  if (duplicate) {
    out.push({
      code: 'duplicateEdge',
      message: `${edge.child} is already in ${edge.parent} via '${edge.kind}'.`,
      edge,
    });
  }

  // Disjoint kinds: SKOS S27 — `related` may not co-exist with a hierarchical edge. Symmetric in
  // both senses: either kind may declare the disjointness, and the two edges may point either way
  // (otherwise related-then-contains was accepted while contains-then-related was refused).
  const disjoint = (a: string, b: string): boolean =>
    Boolean(p.edgeKinds[a]?.disjointWith?.includes(b) || p.edgeKinds[b]?.disjointWith?.includes(a));
  const reverse = edgesInto(space, edge.parent).filter((e) => e.parent === edge.child && e.id !== edge.id);
  const conflicting = [...between, ...reverse].find((e) => disjoint(edge.kind, e.kind));
  if (conflicting) {
    out.push({
      code: 'disjointEdgeKind',
      message: `Edge kind '${edge.kind}' is disjoint from '${conflicting.kind}', which already links ${conflicting.parent} → ${conflicting.child}.`,
      edge,
    });
  }

  // One target per child for a capped kind (an alias has one canonical name).
  if (kindDef.maxPerChild !== undefined) {
    const already = edgesInto(space, edge.child).filter((e) => e.kind === edge.kind && e.id !== edge.id).length;
    if (already + 1 > kindDef.maxPerChild) {
      out.push({
        code: 'maxPerChild',
        message: `${edge.child} would have ${already + 1} '${edge.kind}' edges; kind '${edge.kind}' allows ${kindDef.maxPerChild} per node.`,
        edge,
      });
    }
  }

  // Acyclicity. Enforced for any kind that participates in closure.
  if (kindDef.transitive || kindDef.acyclic) {
    const cycle = findCycle(space, edge.parent, edge.child);
    if (cycle) {
      out.push({
        code: 'cycle',
        message: `Adding ${edge.child} to ${edge.parent} would create a cycle: ${cycle.join(' → ')}.`,
        edge,
        path: cycle,
      });
    }
  }

  // An associative link (`related`) is not membership: none of the structural rules below apply.
  if (!isMembershipKind(p, edge.kind)) return out;

  const childIsGroup = groupNess(edge.child);
  const nestingForbidden = childIsGroup && !p.groupsMayContainGroups;

  if (nestingForbidden) {
    out.push({
      code: 'groupsMayContainGroups',
      message: `Profile '${p.name}' forbids groups inside groups (${edge.child} is a group).`,
      edge,
    });
  }
  if (!childIsGroup && !p.groupsMayContainItems) {
    out.push({
      code: 'groupsMayContainItems',
      message: `Profile '${p.name}' forbids items inside groups; ${edge.child} is not a group.`,
      edge,
    });
  }

  // Parent-count caps. A node's cap depends on whether it is itself a group.
  const currentParents = membershipParentCount(space, edge.child);
  const cap = childIsGroup ? p.maxParentsPerGroup : p.maxParentsPerItem;
  if (cap !== null && currentParents + 1 > cap) {
    out.push({
      code: childIsGroup ? 'maxParentsPerGroup' : 'maxParentsPerItem',
      message: `${edge.child} would have ${currentParents + 1} parents; profile '${p.name}' allows ${cap}.`,
      edge,
    });
  }

  if (!childIsGroup && p.maxGroupsPerItem !== null && currentParents + 1 > p.maxGroupsPerItem) {
    out.push({
      code: 'maxGroupsPerItem',
      message: `${edge.child} would be in ${currentParents + 1} groups; profile '${p.name}' allows ${p.maxGroupsPerItem}.`,
      edge,
    });
  }

  // Depth of the GROUP hierarchy. `maxDepth: 0` means flat — no group may sit inside another —
  // while still permitting an item to be tagged, which is exactly the flat-tagging case.
  // Putting a plain item into a group adds no nesting, so it is never capped by `maxDepth`.
  // (Skipped when nesting is forbidden outright: one cause, one violation.)
  if (p.maxDepth !== null && kindDef.transitive && childIsGroup && !nestingForbidden) {
    const resulting = depthAbove(space, edge.parent) + 1 + groupDepthBelow(space, edge.child, groupNess);
    if (resulting > p.maxDepth) {
      out.push({
        code: 'maxDepth',
        message: `Nesting ${edge.child} inside ${edge.parent} would make the group hierarchy ${resulting} deep; profile '${p.name}' allows ${p.maxDepth}.`,
        edge,
      });
    }
  }

  // The parent BECOMES a group with this edge (its first member). Its existing memberships were
  // checked as an item's; from now on they are group-in-group nesting, so they must satisfy the
  // group rules too — or `flatTags` breaks in two innocent steps (tag `holiday` with `travel`, then
  // tag a photo with `holiday`).
  if (!isGroup(space, edge.parent) && !becomingReported.has(edge.parent)) {
    const parents = membershipParentCount(space, edge.parent);
    const before = out.length;
    if (parents > 0 && !p.groupsMayContainGroups) {
      out.push({
        code: 'groupsMayContainGroups',
        message: `${edge.parent} is itself in ${parents} group(s), so giving it members would nest groups; profile '${p.name}' forbids groups inside groups.`,
        edge,
        node: edge.parent,
      });
    }
    if (p.maxParentsPerGroup !== null && parents > p.maxParentsPerGroup) {
      out.push({
        code: 'maxParentsPerGroup',
        message: `${edge.parent} has ${parents} parents — fine for an item, but giving it members makes it a group, and profile '${p.name}' allows a group ${p.maxParentsPerGroup}.`,
        edge,
        node: edge.parent,
      });
    }
    if (p.maxDepth !== null && parents > 0 && p.groupsMayContainGroups) {
      const resulting = depthAbove(space, edge.parent);
      if (resulting > p.maxDepth) {
        out.push({
          code: 'maxDepth',
          message: `Giving ${edge.parent} members makes it a group nested ${resulting} deep; profile '${p.name}' allows ${p.maxDepth}.`,
          edge,
          node: edge.parent,
        });
      }
    }
    if (out.length > before) becomingReported.add(edge.parent);
  }

  return out;
}

/** The item rules, for a node that just stopped being a group. */
function itemRuleViolations<P>(space: GroupSpace<P>, id: NodeId): Violation[] {
  const p = space.profile;
  const parents = membershipParentCount(space, id);
  const out: Violation[] = [];
  const lost = `${id} lost its last member, so it is an item now`;
  if (parents > 0 && !p.groupsMayContainItems) {
    out.push({ code: 'groupsMayContainItems', node: id, message: `${lost}, and profile '${p.name}' forbids items inside groups.` });
  }
  if (p.maxParentsPerItem !== null && parents > p.maxParentsPerItem) {
    out.push({
      code: 'maxParentsPerItem',
      node: id,
      message: `${lost} with ${parents} parents; profile '${p.name}' allows an item ${p.maxParentsPerItem}. Remove it from a group first.`,
    });
  } else if (p.maxGroupsPerItem !== null && parents > p.maxGroupsPerItem) {
    out.push({
      code: 'maxGroupsPerItem',
      node: id,
      message: `${lost} in ${parents} groups; profile '${p.name}' allows an item ${p.maxGroupsPerItem}.`,
    });
  }
  return out;
}

/**
 * Re-validate a whole space against a profile (by default its own).
 *
 * Use it on data the write path never saw — an import, a manifest a person edited, a foreign store
 * adapter — and to ask "would this space survive under that profile?" (`inferProfile` asks it of
 * every built-in profile). Empty means valid. Per-family rules are reported once the structure is
 * sound (see `applyDelta`).
 */
export function validateProfile<P>(
  space: GroupSpace<P>,
  profile: ProfileName | GroupProfile = space.profile,
): Violation[] {
  const empty = createGroupSpace<P>({ profile });
  const result = applyDelta(empty, {
    upsertNodes: [...space.nodes.values()],
    added: [...space.edges.values()],
  });
  return result.ok ? [] : [...result.violations];
}

// ── undo, for free ──────────────────────────────────────────────────────────

/**
 * The inverse of a delta, computed against the space it was applied to.
 *
 * Undo is Command, not Memento: we never snapshot the space. The inverse is exact — applying
 * `delta` and then `invert(space, delta)` gives back a space with the same nodes and edges:
 *
 * - removed edges come back, added edges go away;
 * - tombstoned nodes (`removedNodes`) come back as they were — label, payload, family rule — as
 *   `addedNodes`, so the undo is refused (`nodeExists`) if the node was re-created since;
 * - nodes the delta created (by `addedNodes`, an upsert, or implicitly as an edge endpoint) are
 *   removed again, as tombstones of their content after the delta — so the undo is refused
 *   (`staleTombstone`) if someone changed them since;
 * - fields an upsert changed are restored, and fields it added are cleared.
 */
export function invert<P>(space: GroupSpace<P>, delta: EdgeDelta): EdgeDelta {
  const removedEdgeIds = new Set(delta.removed ?? []);
  const removedNodeIds = new Set((delta.removedNodes ?? []).map((n) => n.id));

  const added: Edge[] = [];
  for (const id of removedEdgeIds) {
    const edge = space.edges.get(id);
    if (edge) added.push(edge);
  }
  const removed: EdgeId[] = (delta.added ?? []).map((edge) => edge.id);

  // Tombstones come back as CREATES, so the undo is refused if the node was re-created since.
  const addedNodes: Node<unknown>[] = [];
  for (const id of removedNodeIds) {
    const node = space.nodes.get(id);
    if (node) addedNodes.push(node); // the tombstone's authoritative content is the space's
  }
  const upsertNodes: Node<unknown>[] = [];

  // Nodes this delta brought into existence go again.
  const created = new Map<NodeId, Node<unknown>>();
  const touch = (id: NodeId, patch?: Node<unknown>): void => {
    if (space.nodes.has(id) || removedNodeIds.has(id)) return;
    created.set(id, patch ? mergeNode(created.get(id) ?? { id }, patch) : (created.get(id) ?? { id }));
  };
  for (const node of delta.addedNodes ?? []) touch(node.id, node);
  for (const node of delta.upsertNodes ?? []) touch(node.id, node);
  for (const edge of delta.added ?? []) {
    touch(edge.parent);
    touch(edge.child);
  }

  // Nodes this delta changed get their previous fields back, and lose the ones it added.
  const changedKeys = new Map<NodeId, Set<string>>();
  for (const node of delta.upsertNodes ?? []) {
    if (!space.nodes.has(node.id) || removedNodeIds.has(node.id)) continue;
    const keys = changedKeys.get(node.id) ?? new Set<string>();
    for (const key of Object.keys(node)) keys.add(key);
    changedKeys.set(node.id, keys);
  }
  for (const [id, keys] of changedKeys) {
    const prior = space.nodes.get(id)! as unknown as Record<string, unknown>;
    const restore: Record<string, unknown> = { ...prior };
    for (const key of keys) if (!(key in prior)) restore[key] = undefined;
    upsertNodes.push(restore as unknown as Node<unknown>);
  }

  return {
    added,
    removed,
    ...(addedNodes.length ? { addedNodes } : {}),
    ...(upsertNodes.length ? { upsertNodes } : {}),
    ...(created.size ? { removedNodes: [...created.values()] } : {}),
  };
}

// ── ergonomic wrappers (all of them are just deltas) ────────────────────────

/** Put a node in a group. Under `filesystem` this fails if it already has a parent — by design. */
export function addTo<P>(
  space: GroupSpace<P>,
  child: NodeId,
  parent: NodeId,
  init: Partial<Omit<Edge, 'parent' | 'child'>> = {},
): Result<GroupSpace<P>> {
  return applyDelta(space, { added: [makeEdge(parent, child, init)] });
}

/** Take a node out of one group. Not a delete — the node and its other memberships survive. */
export function removeFrom<P>(space: GroupSpace<P>, child: NodeId, parent: NodeId): Result<GroupSpace<P>> {
  const ids = edgesInto(space, child)
    .filter((e) => e.parent === parent)
    .map((e) => e.id);
  return applyDelta(space, { removed: ids });
}

/**
 * What `moveTo` / `moveDelta` take: which edge moves (`fromKind`), and fields to set on the moved
 * edge (`kind` re-types it, `label` / `order` / `meta` / `id` replace the carried ones). An
 * `undefined` field is ignored, never a clear: a move keeps what it is not told to change.
 */
export type MoveInit = Partial<Omit<Edge, 'parent' | 'child'>> & {
  /** Move only the edge of this kind from `from` (the edge on screen). Default: every edge from `from`. */
  readonly fromKind?: EdgeKind;
};

/**
 * The delta that moves a node from one group to another: its edges from `from` are re-pointed to
 * `to`, each **keeping its kind, label and meta** (a moved `part_of` stays `part_of`).
 *
 * - `init.fromKind` picks which edge moves; without it, every edge from `from` to `child` moves (in
 *   practice the one there is). When none matches, the move is a plain add of
 *   `init.kind ?? 'contains'` (a move out of a group the node is not in removes nothing).
 * - A ranked edge (one with an `order`) is re-ranked after `to`'s last ranked child: a rank only
 *   means something among the siblings it was minted for, so carrying it across would drop the node
 *   at an arbitrary position (or onto a tie). `init.order` places every moved edge there instead.
 * - Other `init` fields override the carried ones (`kind` re-types the moved edge).
 * - `from === to` is a no-op (an empty delta), not a move to the end of the list.
 *
 * @throws when `init.id` is given and more than one edge would move — one id cannot name two
 *   edges. (`moveTo` and `Groups.move` report it as a `malformed` violation instead.)
 */
export function moveDelta<P>(space: GroupSpace<P>, child: NodeId, from: NodeId, to: NodeId, init: MoveInit = {}): EdgeDelta {
  const { fromKind, ...fields } = definedFields(init);
  if (from === to) return { added: [], removed: [] };
  const moving = edgesMoving(space, child, from, fromKind);
  if (!moving.length) return { removed: [], added: [makeEdge(to, child, fields)] };
  if (fields.id !== undefined && moving.length > 1) throw new Error(moveIdProblem(moving.length, from, child));
  let last: string | undefined | null = null; // null: not computed yet (it walks `to`'s children)
  const nextRank = (): string => {
    if (last === null) last = lastRankIn(space, to);
    last = orderBetween(last, undefined);
    return last;
  };
  const added = moving.map((e) => {
    const order = fields.order ?? (e.order !== undefined ? nextRank() : undefined);
    return makeEdge(to, child, { ...carriedFields(e), ...fields, ...(order !== undefined ? { order } : {}) });
  });
  return { removed: moving.map((e) => e.id), added };
}

/**
 * Move a node from one group to another — remove + add, atomically (`moveDelta`, applied).
 *
 * Distinct from `addTo`, and the distinction is the single most dangerous one in the UI: a *move*
 * destroys an edge the user often cannot see. Renderers should default to `addTo` and require a
 * modifier for `moveTo` (Gmail's `Label` vs `Move to`). The moved edge keeps its kind, label and
 * meta; see `moveDelta` for which edge moves and where a ranked edge lands.
 */
export function moveTo<P>(space: GroupSpace<P>, child: NodeId, from: NodeId, to: NodeId, init: MoveInit = {}): Result<GroupSpace<P>> {
  const refused = moveViolation(space, child, from, to, init);
  if (refused) return { ok: false, violations: [refused] };
  return applyDelta(space, moveDelta(space, child, from, to, init));
}

/**
 * Can this node be moved from one group to another? The violations `moveTo` would report, without
 * copying the space (`canApply` over `moveDelta`): the move-shaped twin of `canAddTo`, for a drag
 * target that checks a ⌥ move on every dragover.
 */
export function canMoveTo<P>(space: GroupSpace<P>, child: NodeId, from: NodeId, to: NodeId, init: MoveInit = {}): Violation[] {
  const refused = moveViolation(space, child, from, to, init);
  if (refused) return [refused];
  return canApply(space, moveDelta(space, child, from, to, init));
}

/** Why `moveDelta` would throw, as a violation: `init.id` with several edges to move. */
export function moveViolation<P>(space: GroupSpace<P>, child: NodeId, from: NodeId, to: NodeId, init: MoveInit = {}): Violation | undefined {
  if (init.id === undefined || from === to) return undefined;
  const count = edgesMoving(space, child, from, init.fromKind).length;
  return count > 1 ? { code: 'malformed', message: moveIdProblem(count, from, child) } : undefined;
}

function edgesMoving<P>(space: GroupSpace<P>, child: NodeId, from: NodeId, fromKind: EdgeKind | undefined): Edge[] {
  return edgesInto(space, child).filter((e) => e.parent === from && (fromKind === undefined || e.kind === fromKind));
}

const moveIdProblem = (count: number, from: NodeId, child: NodeId): string =>
  `${count} edges link ${from} → ${child}, and one id cannot name them all; pass fromKind to pick one.`;

/** `init` without its `undefined` fields, so spreading it never clears a carried field. */
function definedFields(init: MoveInit): MoveInit {
  return Object.fromEntries(Object.entries(init).filter(([, v]) => v !== undefined)) as MoveInit;
}

/** The highest rank among `group`'s children, or `undefined` when none is ranked. */
function lastRankIn<P>(space: GroupSpace<P>, group: NodeId): string | undefined {
  let last: string | undefined;
  for (const e of edgesOf(space, group)) {
    if (e.order !== undefined && (last === undefined || compareOrder(e.order, last) > 0)) last = e.order;
  }
  return last;
}

/** The fields an edge keeps when it is re-pointed (by a move or a merge): everything but its ends and id. */
function carriedFields(e: Edge): MoveInit {
  return {
    kind: e.kind,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.order !== undefined ? { order: e.order } : {}),
    ...(e.meta !== undefined ? { meta: e.meta } : {}),
  };
}

/**
 * The delta that deletes a node: every edge touching it, plus the node itself as a **tombstone**.
 *
 * Because the tombstone carries the whole node, `invert(space, deleteNodeDelta(space, id))` brings
 * the node back with its label, payload and every edge — undoing a group delete (or the delete half
 * of a merge) loses nothing. Returns an empty delta for an unknown id.
 */
export function deleteNodeDelta<P>(space: GroupSpace<P>, id: NodeId): EdgeDelta {
  const node = space.nodes.get(id);
  const touching = new Set([...edgesInto(space, id), ...edgesOf(space, id)].map((e) => e.id));
  return {
    removed: [...touching],
    ...(node ? { removedNodes: [node as Node<unknown>] } : {}),
  };
}

export interface MergeOptions {
  /** Id for a re-pointed edge. Defaults to `makeEdge`'s minted ids. */
  readonly mintId?: (parent: NodeId, child: NodeId, kind: string) => EdgeId;
}

/**
 * The delta that merges `from` into `into` — "`todo` and `to-do` are the same tag":
 *
 * 1. every membership of `from` (its members, and the groups it is in) is re-pointed to `into`,
 *    keeping the edge's kind, label, order and meta;
 * 2. a re-pointed edge `into` already has (same other end, same kind) is skipped, not doubled, and
 *    the edge between `from` and `into` themselves is dropped rather than made a self-edge;
 * 3. `from` is deleted with a tombstone (`deleteNodeDelta`), so `invert` undoes the whole merge.
 *
 * `into` keeps its own label and payload; `from`'s live on only in the tombstone. A merge that
 * would close a cycle (`into` sits below `from` through a third group) is refused by `applyDelta`
 * with the path, like any other cyclic delta. `into` is created bare if it does not exist (a
 * rename by merge). Returns an empty delta for an unknown `from`.
 *
 * @throws when `from === into` — a caller bug, not a no-op to paper over.
 */
export function mergeDelta<P>(space: GroupSpace<P>, from: NodeId, into: NodeId, options: MergeOptions = {}): EdgeDelta {
  if (from === into) throw new Error(`mergeDelta: cannot merge ${from} into itself.`);
  if (!space.nodes.has(from)) return { added: [], removed: [] };
  const mint = (parent: NodeId, child: NodeId, kind: string) => options.mintId?.(parent, child, kind);
  const has = (parent: NodeId, child: NodeId, kind: string) =>
    edgesInto(space, child).some((x) => x.parent === parent && x.kind === kind);

  const added: Edge[] = [];
  for (const e of edgesOf(space, from)) {
    if (e.child === into || has(into, e.child, e.kind)) continue;
    const id = mint(into, e.child, e.kind);
    added.push(makeEdge(into, e.child, { ...carriedFields(e), ...(id !== undefined ? { id } : {}) }));
  }
  for (const e of edgesInto(space, from)) {
    if (e.parent === into || has(e.parent, into, e.kind)) continue;
    const id = mint(e.parent, into, e.kind);
    added.push(makeEdge(e.parent, into, { ...carriedFields(e), ...(id !== undefined ? { id } : {}) }));
  }
  return { ...deleteNodeDelta(space, from), added };
}

/** Delete a node entirely, and every edge touching it. This *is* destructive — but invertible. */
export function deleteNode<P>(space: GroupSpace<P>, id: NodeId): Result<GroupSpace<P>> {
  return applyDelta(space, deleteNodeDelta(space, id));
}

/**
 * Could `validateEdge` refuse a PLAIN ITEM put in `group` by an edge of `kind`? `false` is a
 * guarantee: for every node with no children, other than `group`, that has no edge of `kind` from
 * `group` yet, `validateEdge(space, makeEdge(group, item, { kind }))` is empty. A caller adding many
 * items (the tagging menu, a bulk tag) can then skip the per-item check. `true` means "check each".
 *
 * The guarantee holds when: `kind` is a declared membership kind with no `maxPerChild`; the profile admits items in
 * groups and caps no item's parents; `group` already has children (so it is not *becoming* a
 * group, which brings its own rules); and `group` has no outgoing edge of a kind disjoint with
 * `kind` (`related` vs `contains`: a plain item has nothing below it, so that is the only place a
 * disjoint edge between the two can be). Cycles and depth cannot fire: an item has nothing below
 * it, and putting one in a group adds no nesting. Family rules (`maxPerItem`) are not structural:
 * check `hasFamilyAtOrAbove` too. Cost: one pass over `group`'s outgoing edges when the profile
 * declares a kind disjoint with `kind`, else constant.
 */
export function mayRefusePlainItems<P>(space: GroupSpace<P>, group: NodeId, kind: string = CONTAINS): boolean {
  const p = space.profile;
  if (!p.edgeKinds[kind] || !isMembershipKind(p, kind) || p.edgeKinds[kind]!.maxPerChild !== undefined) return true;
  if (!p.groupsMayContainItems || p.maxParentsPerItem !== null || p.maxGroupsPerItem !== null) return true;
  if (!isGroup(space, group)) return true;
  const disjoint = new Set(
    Object.entries(p.edgeKinds)
      .filter(([other, def]) => def.disjointWith?.includes(kind) || p.edgeKinds[kind]!.disjointWith?.includes(other))
      .map(([other]) => other),
  );
  if (!disjoint.size) return false;
  for (const id of space.forward.get(group) ?? []) if (disjoint.has(space.edges.get(id)?.kind ?? '')) return true;
  return false;
}

/**
 * Could removing EVERY member of `group` be refused? `false` is a guarantee that it passes. Emptying
 * a group makes it an item (D29), and only its own memberships can then break an item rule
 * (`groupsMayContainItems`, the item caps, a family above it). A group with no incoming edge at
 * all, or a profile where none of those rules can apply, is safe.
 */
export function mayRefuseEmptying<P>(space: GroupSpace<P>, group: NodeId): boolean {
  if (!(space.inverse.get(group)?.size ?? 0)) return false;
  const p = space.profile;
  if (!p.groupsMayContainItems || p.maxParentsPerItem !== null || p.maxGroupsPerItem !== null) return true;
  return hasFamilyAtOrAbove(space, group);
}

/**
 * Can this node be added to this group? Returns the violations, so the UI can explain *why not*.
 *
 * This is what a drag-and-drop target calls on hover.
 */
export function canAddTo<P>(space: GroupSpace<P>, child: NodeId, parent: NodeId, kind = CONTAINS): Violation[] {
  const edge = makeEdge(parent, child, { kind });
  const structural = validateEdge(space, edge);
  if (structural.length) return structural;
  // Per-family cardinality depends on the state after the drop; only pay for it when a family
  // rule could apply.
  if (!hasFamilyAtOrAbove(space, parent)) return [];
  return canApply(space, { added: [edge] });
}
