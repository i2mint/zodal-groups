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
 * Structure only — ids are strings, optional fields have the right type, ids are unique. Profile
 * rules are not checked here (see the module docstring).
 */
export function parseSnapshot<P = unknown>(value: unknown): GroupSnapshot<P> {
  const fail = (path: string, problem: string): never => {
    throw new TypeError(`${path}: ${problem}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const str = (v: unknown, path: string, { optional = false } = {}): void => {
    if (v === undefined && optional) return;
    if (typeof v !== 'string' || (!optional && v === '')) fail(path, `expected a non-empty string, got ${JSON.stringify(v)}`);
  };

  if (!isObject(value)) fail('snapshot', 'expected an object with `nodes` and `edges` arrays');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.nodes)) fail('nodes', 'expected an array');
  if (!Array.isArray(v.edges)) fail('edges', 'expected an array');
  if (v.revision !== undefined && !(Number.isInteger(v.revision) && (v.revision as number) >= 0)) {
    fail('revision', `expected a non-negative integer, got ${JSON.stringify(v.revision)}`);
  }

  const nodeIds = new Set<string>();
  (v.nodes as unknown[]).forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!isObject(n)) return fail(at, 'expected an object');
    str(n.id, `${at}.id`);
    if (nodeIds.has(n.id as string)) fail(`${at}.id`, `duplicate node id ${JSON.stringify(n.id)}`);
    nodeIds.add(n.id as string);
    str(n.label, `${at}.label`, { optional: true });
    if (n.family !== undefined) {
      const f = n.family;
      if (!isObject(f) || !(Number.isInteger(f.maxPerItem) && (f.maxPerItem as number) >= 0)) {
        fail(`${at}.family`, `expected { maxPerItem: a non-negative integer }, got ${JSON.stringify(f)}`);
      }
    }
  });

  const edgeIds = new Set<string>();
  (v.edges as unknown[]).forEach((e, i) => {
    const at = `edges[${i}]`;
    if (!isObject(e)) return fail(at, 'expected an object');
    for (const key of ['id', 'parent', 'child', 'kind'] as const) str(e[key], `${at}.${key}`);
    if (edgeIds.has(e.id as string)) fail(`${at}.id`, `duplicate edge id ${JSON.stringify(e.id)}`);
    edgeIds.add(e.id as string);
    str(e.label, `${at}.label`, { optional: true });
    str(e.order, `${at}.order`, { optional: true });
    if (e.meta !== undefined && !isObject(e.meta)) fail(`${at}.meta`, 'expected an object');
  });

  return value as unknown as GroupSnapshot<P>;
}
