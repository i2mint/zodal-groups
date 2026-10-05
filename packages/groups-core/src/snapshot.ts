/**
 * Snapshots — a group space as flat, serializable `nodes[]` + `edges[]`.
 *
 * This is the persisted shape (D20: validate flat arrays, never a recursive schema). A store
 * adapter writes `toSnapshot(space)` and reads back with `parseSnapshot` (structure only) followed by
 * `fromSnapshot` (indexes only). Neither applies the profile: data on disk may predate the profile,
 * or come from a tool that never heard of it, and the read path must stay usable on it (D8 —
 * enforce on write, never trust on read). Ask `validateProfile` or `inferProfile` what shape it is
 * actually in.
 */

import type { Edge, EdgeId, GroupSpace, Node, NodeId } from './model.js';
import { resolveProfile, type GroupProfile, type ProfileName } from './profile.js';
import { edgeProblem, nodeProblem } from './structure.js';

/** A space without its indexes or profile: what a store persists. */
export interface GroupSnapshot<P = unknown> {
  readonly nodes: readonly Node<P>[];
  readonly edges: readonly Edge[];
  /** The space's revision when the snapshot was taken. */
  readonly revision?: number;
}

/** The flat, serializable form of a space. */
export function toSnapshot<P>(space: GroupSpace<P>): GroupSnapshot<P> {
  return {
    nodes: [...space.nodes.values()],
    edges: [...space.edges.values()],
    revision: space.revision,
  };
}

export interface FromSnapshotOptions {
  readonly profile?: ProfileName | GroupProfile;
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
}

/**
 * Rebuild a space from a snapshot: the indexes, nothing else.
 *
 * Unlike `createGroupSpace`, this does **not** validate against the profile — it is the read path,
 * and the data may violate it (or even contain cycles; every projection is cycle-safe). An edge
 * whose endpoint is missing from `nodes` gets a bare node, as `applyDelta` would have created.
 */
export function fromSnapshot<P>(snapshot: GroupSnapshot<P>, options: FromSnapshotOptions = {}): GroupSpace<P> {
  const nodes = new Map<NodeId, Node<P>>();
  for (const node of snapshot.nodes) nodes.set(node.id, node);
  const edges = new Map<EdgeId, Edge>();
  const forward = new Map<NodeId, Set<EdgeId>>();
  const inverse = new Map<NodeId, Set<EdgeId>>();
  const index = (map: Map<NodeId, Set<EdgeId>>, key: NodeId, id: EdgeId): void => {
    const set = map.get(key);
    if (set) set.add(id);
    else map.set(key, new Set([id]));
  };
  for (const edge of snapshot.edges) {
    edges.set(edge.id, edge);
    index(forward, edge.parent, edge.id);
    index(inverse, edge.child, edge.id);
    if (!nodes.has(edge.parent)) nodes.set(edge.parent, { id: edge.parent } as Node<P>);
    if (!nodes.has(edge.child)) nodes.set(edge.child, { id: edge.child } as Node<P>);
  }
  return {
    profile: resolveProfile(options.profile, options.overrides),
    revision: snapshot.revision ?? 0,
    nodes,
    edges,
    forward,
    inverse,
  };
}

/**
 * Check that an unknown value (parsed JSON, an IndexedDB record…) has the snapshot's structure, and
 * return it typed. Throws a `TypeError` naming the first offending path (`edges[3].parent: …`).
 *
 * Structure only — the same `nodeProblem` / `edgeProblem` checks `applyDelta` applies on write, so
 * anything a store wrote loads back — plus unique ids. Profile rules are not checked here (see the
 * module docstring).
 */
export function parseSnapshot<P = unknown>(value: unknown): GroupSnapshot<P> {
  const fail = (path: string, problem: string): never => {
    throw new TypeError(`${path}: ${problem}`);
  };
  /** `nodeProblem`/`edgeProblem` say `"field: problem"`, or `"expected an object"` for the item. */
  const at = (base: string, problem: string): never => {
    const field = /^(\w+): (.*)$/s.exec(problem);
    return field ? fail(`${base}.${field[1]}`, field[2]!) : fail(base, problem);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObject(value)) fail('snapshot', 'expected an object with `nodes` and `edges` arrays');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.nodes)) fail('nodes', 'expected an array');
  if (!Array.isArray(v.edges)) fail('edges', 'expected an array');
  if (v.revision !== undefined && !(Number.isInteger(v.revision) && (v.revision as number) >= 0)) {
    fail('revision', `expected a non-negative integer, got ${JSON.stringify(v.revision)}`);
  }

  const nodeIds = new Set<string>();
  (v.nodes as unknown[]).forEach((n, i) => {
    const problem = nodeProblem(n);
    if (problem) at(`nodes[${i}]`, problem);
    const id = (n as { id: string }).id;
    if (nodeIds.has(id)) fail(`nodes[${i}].id`, `duplicate node id ${JSON.stringify(id)}`);
    nodeIds.add(id);
  });

  const edgeIds = new Set<string>();
  (v.edges as unknown[]).forEach((e, i) => {
    const problem = edgeProblem(e);
    if (problem) at(`edges[${i}]`, problem);
    const id = (e as { id: string }).id;
    if (edgeIds.has(id)) fail(`edges[${i}].id`, `duplicate edge id ${JSON.stringify(id)}`);
    edgeIds.add(id);
  });

  return value as unknown as GroupSnapshot<P>;
}

// ── read-only views ─────────────────────────────────────────────────────────

const MUTATORS: ReadonlySet<PropertyKey> = new Set(['set', 'add', 'delete', 'clear']);

/**
 * `target` with its mutating methods replaced by ones that throw. A Proxy rather than a wrapper
 * class, so every read method — including ones newer lib versions add — keeps working, and nothing
 * is copied.
 */
function readOnly<T extends object>(target: T, overrides: Readonly<Record<PropertyKey, unknown>> = {}): T {
  return new Proxy(target, {
    get(t, prop) {
      if (MUTATORS.has(prop)) {
        return () => {
          throw new TypeError('This space is a read-only view held by a store; change it by applying a delta.');
        };
      }
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

/** A read-only index map whose sets are read-only too (wrapped lazily, on the way out). */
function readOnlyIndex(index: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>): ReadonlyMap<NodeId, ReadonlySet<EdgeId>> {
  const wrap = (set: ReadonlySet<EdgeId>) => readOnly(set);
  function* entries(): Generator<[NodeId, ReadonlySet<EdgeId>]> {
    for (const [key, set] of index) yield [key, wrap(set)];
  }
  function* values(): Generator<ReadonlySet<EdgeId>> {
    for (const set of index.values()) yield wrap(set);
  }
  return readOnly(index, {
    get: (key: NodeId) => {
      const set = index.get(key);
      return set === undefined ? undefined : wrap(set);
    },
    entries,
    values,
    [Symbol.iterator]: entries,
    forEach: (callback: (value: ReadonlySet<EdgeId>, key: NodeId, map: unknown) => void, thisArg?: unknown) =>
      index.forEach((set, key) => callback.call(thisArg, wrap(set), key, index)),
  });
}

/**
 * A view of `space` whose maps and index sets cannot be mutated, even through a cast — what a store
 * hands out from `load()` when it keeps the space itself in memory. O(1): nothing is copied.
 * Nodes and edges are shared objects, typed `readonly`; treat them as immutable.
 */
export function readonlySpace<P>(space: GroupSpace<P>): GroupSpace<P> {
  return Object.freeze({
    profile: space.profile,
    revision: space.revision,
    nodes: readOnly(space.nodes),
    edges: readOnly(space.edges),
    forward: readOnlyIndex(space.forward),
    inverse: readOnlyIndex(space.inverse),
  });
}
