/**
 * Delta plumbing for the collection facade: splitting an `EdgeDelta` into per-item parts and a
 * shared (group-level) part, and putting a subset of those parts back together.
 *
 * Why split at all: an operation over N items is ONE delta per space (applying N single-edge deltas
 * costs O(N²), reconciliation §8.6), yet its failure semantics are per item — an item that cannot be
 * written is dropped and the others go ahead. Both hold if the delta is built for the whole set,
 * partitioned by the item each change belongs to, and recombined for the items still standing.
 *
 * Ownership rule: an edge belongs to its **child** when the child is one of the operation's items
 * (a membership of that item), a node to itself when it is one of the items; everything else —
 * group nodes, group-to-group edges, tombstones of emptied groups — is shared.
 */

import { edgesInto, edgesOf, type Edge, type EdgeDelta, type EdgeId, type GroupSpace, type Node } from '@zodal/groups-core';

/** A delta split by owner. */
export interface Partitioned {
  readonly items: ReadonlyMap<string, EdgeDelta>;
  readonly shared: EdgeDelta;
}

interface MutableDelta {
  added: Edge[];
  removed: EdgeId[];
  upsertNodes: Node[];
  addedNodes: Node[];
  removedNodes: Node[];
}

const emptyMutable = (): MutableDelta => ({ added: [], removed: [], upsertNodes: [], addedNodes: [], removedNodes: [] });

/** Drop the empty arrays, so a delta says only what it does. */
export function compact(d: MutableDelta | EdgeDelta): EdgeDelta {
  const out: { -readonly [K in keyof EdgeDelta]: EdgeDelta[K] } = {};
  if (d.added?.length) out.added = [...d.added];
  if (d.removed?.length) out.removed = [...d.removed];
  if (d.upsertNodes?.length) out.upsertNodes = [...d.upsertNodes];
  if (d.addedNodes?.length) out.addedNodes = [...d.addedNodes];
  if (d.removedNodes?.length) out.removedNodes = [...d.removedNodes];
  return out;
}

export function isEmptyDelta(d: EdgeDelta | undefined): boolean {
  return !d || !(d.added?.length || d.removed?.length || d.upsertNodes?.length || d.addedNodes?.length || d.removedNodes?.length);
}

/** Concatenate deltas field by field. */
export function concatDeltas(deltas: readonly (EdgeDelta | undefined)[]): EdgeDelta {
  const out = emptyMutable();
  for (const d of deltas) {
    if (!d) continue;
    out.added.push(...(d.added ?? []));
    out.removed.push(...(d.removed ?? []));
    out.upsertNodes.push(...(d.upsertNodes ?? []));
    out.addedNodes.push(...(d.addedNodes ?? []));
    out.removedNodes.push(...(d.removedNodes ?? []));
  }
  return compact(out);
}

/**
 * Split `delta` by owner. `lookup` resolves a removed edge id to the edge (from the space the delta
 * applies to, or — for an inverse — from the forward delta that added it); an id it cannot resolve
 * is shared (removing a missing edge is a no-op anyway).
 */
export function partition(
  delta: EdgeDelta,
  lookup: (id: EdgeId) => Edge | undefined,
  owners: ReadonlySet<string>,
): Partitioned {
  const items = new Map<string, MutableDelta>();
  const shared = emptyMutable();
  const bucket = (owner: string | undefined): MutableDelta => {
    if (owner === undefined || !owners.has(owner)) return shared;
    let b = items.get(owner);
    if (!b) items.set(owner, (b = emptyMutable()));
    return b;
  };
  for (const e of delta.added ?? []) bucket(e.child).added.push(e);
  for (const id of delta.removed ?? []) bucket(lookup(id)?.child).removed.push(id);
  for (const n of delta.upsertNodes ?? []) bucket(n.id).upsertNodes.push(n);
  for (const n of delta.addedNodes ?? []) bucket(n.id).addedNodes.push(n);
  for (const n of delta.removedNodes ?? []) bucket(n.id).removedNodes.push(n);
  return {
    items: new Map([...items].map(([k, v]) => [k, compact(v)])),
    shared: compact(shared),
  };
}

/**
 * Recombine the parts of `ids` (plus the shared part when `withShared`), then drop every tombstone
 * whose node would still be touched by an edge afterwards: when some items were dropped, the group
 * they still belong to must survive (an emptied group is only removed once it really is empty).
 */
export function combine(parts: Partitioned, ids: readonly string[], withShared: boolean, space: GroupSpace): EdgeDelta {
  const chosen = ids.map((id) => parts.items.get(id));
  return pruneTombstones(space, concatDeltas(withShared ? [parts.shared, ...chosen] : chosen));
}

/** Drop the tombstones of nodes that `delta` leaves touched by an edge (they would be refused as `danglingEdge`). */
export function pruneTombstones(space: GroupSpace, delta: EdgeDelta): EdgeDelta {
  if (!delta.removedNodes?.length) return delta;
  const removed = new Set<string>(delta.removed ?? []);
  const touchedByAdded = new Set<string>();
  for (const e of delta.added ?? []) {
    touchedByAdded.add(e.parent);
    touchedByAdded.add(e.child);
  }
  const stillTouched = (id: Node['id']): boolean =>
    touchedByAdded.has(id) || [...edgesOf(space, id), ...edgesInto(space, id)].some((e) => !removed.has(e.id));
  return compact({ ...delta, removedNodes: delta.removedNodes.filter((n) => !stillTouched(n.id)) });
}

/** Deep equality for plain JSON-like data (node fields). */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
