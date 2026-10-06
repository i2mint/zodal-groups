/**
 * Space runtimes: one per named space, holding its current `GroupSpace` and knowing how to persist
 * a delta — the `edges` seam of `defineTaggedCollection`.
 *
 * - **Embedded** (`{ embedded: 'tags' }`): the memberships live on the records, as a `string[]`
 *   field of group ids. The space is *derived* from the records (plus a code-declared vocabulary)
 *   on load, kept in memory, and persisted by writing the field. Record edges get a deterministic
 *   id (`recordEdgeId(group, item)`), so an id survives a reload and an inverse stays valid.
 * - **Store** (a `GroupStore`): the store holds the edges. The runtime keeps the last space it saw
 *   and writes with `expectedRevision`/`expectedEpoch`; a `conflict` means another writer got there
 *   first, and the caller reloads and retries. Store edge ids are minted unique.
 */

import {
  applyDelta,
  edgeId,
  edgesInto,
  fromSnapshot,
  invert,
  newEpoch,
  nodeId,
  resolveProfile,
  toSnapshot,
  type Edge,
  type EdgeDelta,
  type EdgeId,
  type EdgeKind,
  type GroupProfile,
  type GroupSpace,
  type GroupStore,
  type Node,
  type NodeId,
  type Violation,
} from '@zodal/groups-core';
import type { SpaceConfig, SpaceEdges, EmbeddedEdges } from './types.js';
import { sameData } from './delta.js';

/** Prefix of every record-edge id. Vocabulary edge ids must not start with it. */
export const RECORD_EDGE_PREFIX = 'rec:';

/** The deterministic id of the record edge `group ⊃ item` (derivable from the record alone). */
export const recordEdgeId = (group: string, item: string): EdgeId =>
  edgeId(`${RECORD_EDGE_PREFIX}${JSON.stringify([group, item])}`);

/** The group of a record-edge id (`undefined` if it is not one). */
export function recordEdgeGroup(id: string): string | undefined {
  if (!id.startsWith(RECORD_EDGE_PREFIX)) return undefined;
  try {
    const pair = JSON.parse(id.slice(RECORD_EDGE_PREFIX.length)) as unknown;
    return Array.isArray(pair) && typeof pair[0] === 'string' ? pair[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Is this edge stored on a record (as opposed to declared in the vocabulary)? */
export const isRecordEdge = (e: Edge): boolean => e.id.startsWith(RECORD_EDGE_PREFIX);

/** A unique edge id, for store spaces: an undo can then never remove a newer edge under a reused id. */
export const uniqueEdgeId = (parent: string, child: string): EdgeId => edgeId(`${parent}>${child}#${newEpoch()}`);

/** The group ids in a record's field: strings only, de-duplicated, in order. Anything else is ignored (never thrown on: D8). */
export function fieldGroups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * The field's next value: `remove` taken out, `add` put in — each added group takes the place of a
 * removed one (so a rename or a merge keeps the item's order), the rest are appended. With
 * `order: 'sorted'` the groups are sorted instead (entries that are not group ids go last). Entries this
 * package does not understand are kept; a new array is always returned (records from a provider
 * may share their arrays).
 */
export function nextField(
  current: unknown,
  remove: ReadonlySet<string>,
  add: readonly string[],
  order: FieldOrder = 'insertion',
): unknown[] {
  const out = insertField(current, remove, add);
  if (order === 'insertion') return out;
  // Binary (code-unit) order, never locale order: the same sort on every machine and backend.
  const groups = out.filter((v): v is string => typeof v === 'string').sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return [...groups, ...out.filter((v) => typeof v !== 'string')];
}

function insertField(current: unknown, remove: ReadonlySet<string>, add: readonly string[]): unknown[] {
  const src = Array.isArray(current) ? current : [];
  const staying = (g: string) => src.includes(g) && !remove.has(g);
  const pending = [...new Set(add)].filter((g) => !staying(g));
  const out: unknown[] = [];
  for (const v of src) {
    if (typeof v === 'string' && remove.has(v)) {
      const next = pending.shift();
      if (next !== undefined) out.push(next);
      continue;
    }
    out.push(v);
  }
  out.push(...pending);
  return out;
}

/** How an embedded field orders its group ids. */
export type FieldOrder = 'insertion' | 'sorted';

export const isEmbedded = (edges: SpaceEdges): edges is EmbeddedEdges =>
  typeof (edges as EmbeddedEdges).embedded === 'string';

/** The outcome of persisting a delta. */
export type CommitOutcome =
  | { readonly kind: 'ok'; readonly inverse: EdgeDelta; readonly before: GroupSpace }
  | { readonly kind: 'conflict'; readonly violations: readonly Violation[] }
  | { readonly kind: 'refused'; readonly violations: readonly Violation[] }
  | { readonly kind: 'io'; readonly error: unknown }
  /** The store threw, and re-reading it cannot tell whether the delta landed. */
  | { readonly kind: 'unknown'; readonly error: unknown };

export interface SpaceRuntime {
  readonly name: string;
  readonly mode: 'embedded' | 'store';
  /** Embedded: the record field. */
  readonly field: string | undefined;
  /** Embedded: how the field orders its group ids. */
  readonly fieldOrder: FieldOrder;
  readonly store: GroupStore | undefined;
  readonly profile: GroupProfile;
  /** Embedded: the vocabulary's node ids (never garbage-collected as emptied groups). */
  readonly vocabularyNodes: ReadonlySet<string>;
  /** The space as last seen. */
  current: GroupSpace;
  /** Embedded: the cache could not follow a write; re-derive before the next operation. */
  stale: boolean;
  /** Mint the id of a new membership edge `parent ⊃ child`. */
  mintEdge(parent: string, child: string, kind?: EdgeKind): Edge;
  /** Store: the epoch learned from the last apply (unknown right after a load). */
  epoch: string | undefined;
}

/** Build a runtime from its config. Throws on a config that cannot work, naming the space. */
export function createSpaceRuntime(name: string, config: SpaceConfig): SpaceRuntime {
  if (!config || !config.edges) throw new Error(`Space '${name}': \`edges\` is required ({ embedded: '<field>' } or a GroupStore).`);
  if (isEmbedded(config.edges)) {
    const field = config.edges.embedded;
    if (!field) throw new Error(`Space '${name}': \`edges.embedded\` must name a record field.`);
    const order = config.edges.order;
    if (order !== undefined && order !== 'insertion' && order !== 'sorted') {
      throw new Error(`Space '${name}': \`edges.order\` must be 'insertion' or 'sorted', got ${JSON.stringify(order)}.`);
    }
    const profile = resolveProfile(config.profile ?? 'polyhierarchy', config.overrides);
    for (const e of config.vocabulary?.edges ?? []) {
      if (e.id.startsWith(RECORD_EDGE_PREFIX)) {
        throw new Error(`Space '${name}': vocabulary edge id '${e.id}' starts with '${RECORD_EDGE_PREFIX}', which is reserved for edges stored on records.`);
      }
    }
    return {
      name,
      mode: 'embedded',
      field,
      fieldOrder: config.edges.order ?? 'insertion',
      store: undefined,
      profile,
      vocabularyNodes: new Set([
        ...(config.vocabulary?.nodes ?? []).map((n) => n.id),
        ...(config.vocabulary?.edges ?? []).flatMap((e) => [e.parent, e.child]),
      ]),
      current: fromSnapshot({ nodes: [], edges: [] }, { profile }),
      stale: true,
      epoch: undefined,
      mintEdge: (parent, child, kind = 'contains') => ({
        id: recordEdgeId(parent, child),
        parent: nodeId(parent),
        child: nodeId(child),
        kind,
      }),
    };
  }
  const store = config.edges as GroupStore;
  if (typeof store.apply !== 'function' || typeof store.load !== 'function') {
    throw new Error(`Space '${name}': \`edges\` must be { embedded: '<field>' } or a GroupStore (with load and apply).`);
  }
  if (config.overrides) {
    throw new Error(`Space '${name}': \`overrides\` applies to embedded spaces; a GroupStore validates with its own profile (${store.profile.name}).`);
  }
  if (config.vocabulary) {
    throw new Error(`Space '${name}': \`vocabulary\` applies to embedded spaces; a GroupStore persists its group nodes and edges itself.`);
  }
  if (config.profile !== undefined) {
    const wanted = typeof config.profile === 'string' ? config.profile : config.profile.name;
    if (wanted !== store.profile.name) {
      throw new Error(`Space '${name}': profile '${wanted}' was requested, but the store validates with '${store.profile.name}'. Construct the store with the profile you want.`);
    }
  }
  return {
    name,
    mode: 'store',
    field: undefined,
    fieldOrder: 'insertion',
    store,
    profile: store.profile,
    vocabularyNodes: new Set(),
    current: fromSnapshot({ nodes: [], edges: [] }, { profile: store.profile }),
    stale: true,
    epoch: undefined,
    mintEdge: (parent, child, kind = 'contains') => ({
      id: uniqueEdgeId(parent, child),
      parent: nodeId(parent),
      child: nodeId(child),
      kind,
    }),
  };
}

/**
 * Derive an embedded space from the records: every record is a node, every id in its field is a
 * record edge `group ⊃ record`, and the vocabulary adds group nodes and group-to-group edges. Not
 * validated against the profile (D8: the data is not ours to refuse on read; `validateProfile`
 * reports its shape).
 */
export function deriveEmbedded(rt: SpaceRuntime, config: SpaceConfig, records: readonly Record<string, unknown>[], idField: string): void {
  const field = rt.field!;
  const nodes = new Map<NodeId, Node>();
  const edges: Edge[] = [...(config.vocabulary?.edges ?? [])];
  for (const record of records) {
    const id = String(record[idField]);
    nodes.set(nodeId(id), { id: nodeId(id) });
    for (const g of fieldGroups(record[field])) edges.push(rt.mintEdge(g, id));
  }
  for (const n of config.vocabulary?.nodes ?? []) nodes.set(n.id, n); // declared fields win over the bare record node
  rt.current = fromSnapshot({ nodes: [...nodes.values()], edges, revision: rt.current.revision + 1 }, { profile: rt.profile });
  rt.stale = false;
}

/**
 * Make the cache agree with records just read: an embedded space is derived from the records, and
 * another writer may have changed one since the last load. Re-derives only the records that differ.
 */
export function resyncEmbedded(rt: SpaceRuntime, records: ReadonlyMap<string, Record<string, unknown>>): void {
  const field = rt.field!;
  const space = rt.current;
  const stale: string[] = [];
  for (const [id, record] of records) {
    const want = fieldGroups(record[field]);
    const have = edgesInto(space, nodeId(id)).filter(isRecordEdge).map((e) => e.parent as string);
    const same = want.length === have.length && want.every((g) => have.includes(g));
    if (!same || !space.nodes.has(nodeId(id))) stale.push(id);
  }
  if (!stale.length) return;
  const staleSet = new Set(stale);
  const snapshot = toSnapshot(space);
  const edges = snapshot.edges.filter((e) => !(isRecordEdge(e) && staleSet.has(e.child)));
  const nodes = [...snapshot.nodes];
  for (const id of stale) {
    if (!space.nodes.has(nodeId(id))) nodes.push({ id: nodeId(id) });
    for (const g of fieldGroups(records.get(id)![field])) edges.push(rt.mintEdge(g, id));
  }
  rt.current = fromSnapshot({ nodes, edges, revision: space.revision + 1 }, { profile: rt.profile });
}

/** Load a store space (the epoch is learned again from the next apply). */
export async function loadStore(rt: SpaceRuntime): Promise<void> {
  rt.current = await rt.store!.load();
  rt.epoch = undefined;
  rt.stale = false;
}

/**
 * Persist `delta`. A store space writes with the revision (and epoch, once known) the delta was
 * built against, so a stale build is refused with `conflict` rather than applied over a newer
 * write. An embedded space only updates its cache: its persistence is the record write, which the
 * caller has already made.
 */
export async function commit(rt: SpaceRuntime, delta: EdgeDelta): Promise<CommitOutcome> {
  const before = rt.current;
  if (rt.mode === 'embedded') {
    // The caller validated this delta against `before`; it can only be refused if the cache is
    // out of step, in which case it is re-derived before the next operation.
    const inverse = invert(before, delta);
    const r = applyDelta(before, delta);
    if (r.ok) rt.current = r.value;
    else rt.stale = true;
    return { kind: 'ok', inverse, before };
  }
  const options = { expectedRevision: before.revision, ...(rt.epoch !== undefined ? { expectedEpoch: rt.epoch } : {}) };
  let result;
  try {
    result = await rt.store!.apply(delta, options);
  } catch (error) {
    // A store may commit and THEN throw (the fs store releases its lock after the rename). Look
    // before assuming nothing happened: compensating a write that landed would split record and edges.
    const verdict = await landed(rt, before, delta);
    if (verdict === 'yes') return { kind: 'ok', inverse: invert(before, delta), before };
    return verdict === 'no' ? { kind: 'io', error } : { kind: 'unknown', error };
  }
  if (!result.ok) {
    return result.violations.some((v) => v.code === 'conflict')
      ? { kind: 'conflict', violations: result.violations }
      : { kind: 'refused', violations: result.violations };
  }
  rt.epoch = result.value.epoch;
  if (result.value.space) rt.current = result.value.space;
  else {
    // The store applied `delta` to exactly `before` (the revision matched), so applying it here
    // gives the store's state — unless something is off, and then we ask the store.
    const local = applyDelta(before, delta);
    if (local.ok && local.value.revision === result.value.revision) rt.current = local.value;
    else rt.current = await rt.store!.load();
  }
  return { kind: 'ok', inverse: result.value.inverse, before };
}

/**
 * After a store threw: did `delta` land on `before`? Re-reads the store and answers only on
 * evidence that the change is OURS, because another writer may have committed in between:
 *
 * - the revision did not move → no;
 * - the delta adds edges under ids `before` did not have (store ids are unique, nobody else can
 *   mint them): all present with every other effect visible → yes; none present after exactly one
 *   write (which was then someone else's) → no;
 * - otherwise the only evidence is content that CHANGED to exactly ours — an edge re-added under
 *   its id with our fields (a move's new rank), a node upserted to our fields. With all effects
 *   visible and such evidence → yes. A delta that only removes, or whose effects are not visible,
 *   cannot be told apart from another writer's work → unknown (the caller fails it, inconsistent).
 */
async function landed(rt: SpaceRuntime, before: GroupSpace, delta: EdgeDelta): Promise<'yes' | 'no' | 'unknown'> {
  try {
    await loadStore(rt);
  } catch {
    return 'unknown';
  }
  const after = rt.current;
  if (after.revision === before.revision) return 'no';
  const oneWrite = after.revision === before.revision + 1;
  const visible = effectsVisible(after, delta);
  const fresh = (delta.added ?? []).filter((e) => !before.edges.has(e.id));
  if (fresh.length) {
    const present = fresh.filter((e) => after.edges.has(e.id)).length;
    if (present === fresh.length && visible) return 'yes';
    return present === 0 && oneWrite ? 'no' : 'unknown';
  }
  const changedToOurs =
    (delta.added ?? []).some((e) => sameData(after.edges.get(e.id), e) && !sameData(before.edges.get(e.id), e)) ||
    (delta.upsertNodes ?? []).some((x) => fieldsMatch(after.nodes.get(x.id), x) && !fieldsMatch(before.nodes.get(x.id), x));
  return visible && changedToOurs ? 'yes' : 'unknown';
}

/** Does `node` carry every field `patch` sets (a field set to `undefined` must be absent)? */
function fieldsMatch(node: Node | undefined, patch: Node): boolean {
  if (!node) return false;
  return Object.entries(patch).every(([k, v]) => sameData((node as unknown as Record<string, unknown>)[k], v));
}

function effectsVisible(space: GroupSpace, delta: EdgeDelta): boolean {
  const added = new Set((delta.added ?? []).map((e) => e.id as string));
  return (
    (delta.added ?? []).every((e) => sameData(space.edges.get(e.id), e)) &&
    (delta.removed ?? []).every((id) => added.has(id) || !space.edges.has(id)) &&
    (delta.addedNodes ?? []).every((x) => space.nodes.has(x.id)) &&
    (delta.upsertNodes ?? []).every((x) => fieldsMatch(space.nodes.get(x.id), x)) &&
    (delta.removedNodes ?? []).every((x) => !space.nodes.has(x.id))
  );
}
