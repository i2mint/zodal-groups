/**
 * `defineTaggedCollection` — one CRUD object over a collection of item records and one or more
 * group spaces over those items, kept consistent.
 *
 * Every operation is a plan for the engine (`./engine.ts`): which items, which spaces, and how to
 * build each space's delta from the operation's *intent* (so it can be rebuilt after a conflict).
 * The builders below are the only place the operations differ.
 */

import {
  closureIds,
  compareOrder,
  createListenerSet,
  deleteNodeDelta,
  edgesInto,
  edgesOf,
  isGroup,
  isMembershipKind,
  mergeDelta,
  newEpoch,
  nodeId,
  orderBetween,
  type Edge,
  type EdgeDelta,
  type EdgeId,
  type EdgeKind,
  type GroupSpace,
  type Node,
  type NodeId,
} from '@zodal/groups-core';
import type { DataProvider } from '@zodal/store';
import { createCommands, operations } from './commands.js';
import { combine, concatDeltas, partition } from './delta.js';
import { emptyInverse, execute, PENDING_ID, type EngineContext, type Plan, type Unit } from './engine.js';
import {
  createSpaceRuntime,
  deriveEmbedded,
  fieldGroups,
  isRecordEdge,
  loadStore,
  nextField,
  recordEdgeId,
  uniqueEdgeId,
  type SpaceRuntime,
} from './spaces.js';
import type {
  CollectionChange,
  CollectionInverse,
  DefineTaggedCollectionOptions,
  FailureCode,
  OperationResult,
  Position,
  SpaceConfig,
  TaggedCollection,
} from './types.js';


const DEFAULT_SPACES: Readonly<Record<string, SpaceConfig>> = Object.freeze({ groups: { edges: { embedded: 'groups' } } });

/**
 * Create a tagged collection.
 *
 * @example One space, embedded on the records (works over any DataProvider).
 * const tc = defineTaggedCollection({ provider, spaces: { tags: { profile: 'flatTags', edges: { embedded: 'tags' } } } });
 * const r = await tc.tag(['a', 'b'], 'urgent');   // → { ok, succeeded, failed, inverse }
 * await tc.revert(r.inverse);                      // the app's undo history calls this
 *
 * @example Several spaces over one item universe (Zotero: collections and tags).
 * defineTaggedCollection({
 *   provider,
 *   spaces: {
 *     tags: { profile: 'flatTags', edges: { embedded: 'tags' } },
 *     collections: { edges: createFsGroupStore({ path: './.collections.json', profile: 'polyhierarchy' }) },
 *   },
 * });
 */
export function defineTaggedCollection<T extends Record<string, unknown>>(
  options: DefineTaggedCollectionOptions<T>,
): TaggedCollection<T> {
  const { provider } = options;
  if (!provider || typeof provider.getOne !== 'function') {
    throw new Error('defineTaggedCollection: `provider` (a @zodal/store DataProvider) is required.');
  }
  const idField = options.idField ?? options.collection?.idField ?? 'id';
  const configs = options.spaces ?? DEFAULT_SPACES;
  const names = Object.keys(configs);
  if (!names.length) throw new Error('defineTaggedCollection: `spaces` declares no space.');
  const runtimes = new Map<string, SpaceRuntime>(names.map((n) => [n, createSpaceRuntime(n, configs[n]!)]));
  checkFields(runtimes, idField, options.collection?.schema);
  const defaultSpace = options.defaultSpace ?? names[0]!;
  if (!runtimes.has(defaultSpace)) {
    throw new Error(`defineTaggedCollection: defaultSpace '${defaultSpace}' is not one of the spaces (${names.join(', ')}).`);
  }
  const maxRetries = options.maxRetries ?? 3;
  const pageSize = options.loadPageSize ?? 1000;
  const recordIds = new Set<string>();
  const ctx: EngineContext<T> = { provider, idField, recordIds, maxRetries, retryDelayMs: options.retryDelayMs ?? 5 };
  const listeners = createListenerSet<CollectionChange<T>>(options.onListenerError);

  // ── lifecycle ─────────────────────────────────────────────────────────────
  let loaded = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** Operations on one instance run one at a time: each builds on the state the previous left. */
  const serialize = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const loadNow = async (): Promise<void> => {
    const embedded = [...runtimes.values()].filter((rt) => rt.mode === 'embedded');
    if (embedded.length) {
      const records = await readAll(provider, pageSize);
      recordIds.clear();
      for (const r of records) recordIds.add(String(r[idField]));
      for (const rt of embedded) deriveEmbedded(rt, configs[rt.name]!, records, idField);
    }
    for (const rt of runtimes.values()) if (rt.mode === 'store') await loadStore(rt);
    loaded = true;
  };
  const ensureLoaded = async (): Promise<void> => {
    if (!loaded || [...runtimes.values()].some((rt) => rt.stale)) await loadNow();
  };

  const runtime = (name: string | undefined): SpaceRuntime => {
    const rt = runtimes.get(name ?? defaultSpace);
    if (!rt) throw new Error(`Unknown space '${name}'. Spaces: ${names.join(', ')}.`);
    return rt;
  };

  /** Run an operation: load, plan (or refuse outright), execute, notify. */
  const run = (operation: string, makePlan: () => Plan<T> | OperationResult<T>): Promise<OperationResult<T>> =>
    serialize(async () => {
      await ensureLoaded();
      const planned = makePlan();
      if ('ok' in planned) return planned;
      const { result, changed } = await execute(ctx, planned);
      if (changed) listeners.emit({ operation, result });
      return result;
    });

  const refuse = (id: string, code: FailureCode, reason: string): OperationResult<T> => ({
    ok: false,
    succeeded: [],
    failed: [{ id, code, reason }],
    inverse: emptyInverse(),
  });
  const done = (id: string): OperationResult<T> => ({ ok: true, succeeded: [id], failed: [], inverse: emptyInverse() });
  const units = (ids: readonly string[]): Unit<T>[] => [...new Set(ids.map(String))].map((id) => ({ id }));

  // ── builders ──────────────────────────────────────────────────────────────
  /** Embedded spaces drop a group nobody is in any more (a reload would not derive it either). */
  const collectEmptied = (rt: SpaceRuntime, space: GroupSpace, delta: EdgeDelta): EdgeDelta => {
    if (rt.mode !== 'embedded') return delta;
    const removed = new Set<string>(delta.removed ?? []);
    const touchedByAdded = new Set((delta.added ?? []).flatMap((e) => [e.parent as string, e.child as string]));
    const gone = new Set((delta.removedNodes ?? []).map((n) => n.id as string));
    const tombstones: Node[] = [];
    for (const id of removed) {
      const g = space.edges.get(id as EdgeId)?.parent;
      if (!g || gone.has(g) || rt.vocabularyNodes.has(g) || recordIds.has(g) || touchedByAdded.has(g)) continue;
      const left = [...edgesOf(space, g), ...edgesInto(space, g)].some((e) => !removed.has(e.id));
      const node = space.nodes.get(g);
      if (!left && node) {
        tombstones.push(node as Node);
        gone.add(g);
      }
    }
    return tombstones.length ? concatDeltas([delta, { removedNodes: tombstones }]) : delta;
  };

  /** An item leaving a space: its memberships, and its node unless it is itself a group (deleteGroup removes that). */
  const dropItemDelta = (rt: SpaceRuntime, space: GroupSpace, itemId: string, keep: ReadonlySet<string> = new Set()): EdgeDelta => {
    const n = nodeId(itemId);
    const node = space.nodes.get(n);
    const removed = edgesInto(space, n).map((e) => e.id).filter((id) => !keep.has(id));
    const tombstone = node && !edgesOf(space, n).length ? { removedNodes: [node as Node] } : {};
    return collectEmptied(rt, space, { removed, ...tombstone });
  };

  /**
   * New memberships of `group`. In an ordered space each gets a rank: at the end, or — with
   * `position` — just before/after a member (if that member is gone by now, at the end).
   */
  const tagDelta = (
    rt: SpaceRuntime,
    space: GroupSpace,
    ids: readonly string[],
    group: string,
    kind: EdgeKind,
    position?: Position,
  ): EdgeDelta => {
    const fresh = ids.filter((id) => !edgesInto(space, nodeId(id)).some((e) => e.parent === group && e.kind === kind));
    if (!isRanked(rt) || !fresh.length) return { added: fresh.map((id) => rt.mintEdge(group, id, kind)) };
    const { ordered, reranked } = ranking(space, group, new Set(fresh));
    let [lo, hi] = slot(ordered, position);
    const added = fresh.map((id) => {
      lo = orderBetween(lo, hi);
      return { ...rt.mintEdge(group, id, kind), order: lo };
    });
    return concatDeltas([rerankDelta(reranked), { added }]);
  };

  /**
   * The members of an ordered group in rank order (minus `moving`), every unranked member given a
   * rank after the ranked ones, in its current place — seeded data, or a profile made ordered later.
   * Unranked members sort last, so without this an appended member would land before them.
   * `reranked` are those edges with their new rank (same id), to put in the delta.
   */
  const ranking = (space: GroupSpace, group: string, moving: ReadonlySet<string>): { ordered: Edge[]; reranked: Edge[] } => {
    const sorted = edgesOf(space, nodeId(group))
      .filter((e) => !moving.has(e.child))
      .sort((x, y) => compareOrder(x.order, y.order));
    let last = sorted.filter((e) => e.order !== undefined).at(-1)?.order;
    const reranked: Edge[] = [];
    const ordered = sorted.map((e) => {
      if (e.order !== undefined) return e;
      last = orderBetween(last, undefined);
      const ranked = { ...e, order: last };
      reranked.push(ranked);
      return ranked;
    });
    return { ordered, reranked };
  };

  /** Re-ranked edges are replaced under their own ids (removed and re-added), so the inverse restores them. */
  const rerankDelta = (reranked: readonly Edge[]): EdgeDelta => ({ removed: reranked.map((e) => e.id), added: [...reranked] });

  /** The ranks a member goes between: at the end, or around the `position` anchor. Throws on a tie (orderBetween). */
  const slot = (ordered: readonly Edge[], position: Position | undefined): [string | undefined, string | undefined] => {
    const anchor = position && (position.before ?? position.after);
    const at = anchor === undefined ? -1 : ordered.findIndex((e) => e.child === anchor);
    if (at < 0) return [ordered.at(-1)?.order, undefined];
    return position!.before !== undefined ? [ordered[at - 1]?.order, ordered[at]!.order] : [ordered[at]!.order, ordered[at + 1]?.order];
  };

  /**
   * After a merge into `into` in an ordered space, the moved memberships keep `from`'s ranks, which
   * may tie with `into`'s: rank them after `into`'s last member instead, in their old order.
   */
  const rankMerge = (rt: SpaceRuntime, space: GroupSpace, into: string, delta: EdgeDelta): EdgeDelta => {
    if (!isRanked(rt)) return delta;
    const moved = (delta.added ?? []).filter((e) => e.parent === into).sort((x, y) => compareOrder(x.order, y.order));
    if (!moved.length) return delta;
    const { ordered, reranked } = ranking(space, into, new Set());
    let last = ordered.at(-1)?.order;
    const ranks = new Map(
      moved.map((e) => {
        last = orderBetween(last, undefined);
        return [e.id, { ...e, order: last }] as const;
      }),
    );
    return concatDeltas([{ ...delta, added: (delta.added ?? []).map((e) => ranks.get(e.id) ?? e) }, rerankDelta(reranked)]);
  };

  /** Does this space keep ranks? A store under an `ordered` profile; never an embedded field (it cannot hold one). */
  const isRanked = (rt: SpaceRuntime): boolean => rt.mode === 'store' && rt.profile.ordered;

  const checkPosition = (rt: SpaceRuntime, position: Position | undefined): void => {
    if (!position) return;
    if (!isRanked(rt)) {
      throw new Error(`Space '${rt.name}' is not ordered (profile '${rt.profile.name}'${rt.mode === 'embedded' ? `; an embedded field cannot hold a rank within a group` : ''}); use an ordered GroupStore space for positions.`);
    }
    if ((position.before === undefined) === (position.after === undefined)) {
      throw new Error('A position needs exactly one of `before` or `after`.');
    }
  };

  /** Memberships only: an associative link (`related`, a custom `membership: false` kind) is not "in the group" and stays. */
  const untagDelta = (rt: SpaceRuntime, space: GroupSpace, ids: readonly string[], group: string): EdgeDelta => ({
    removed: ids.flatMap((id) =>
      edgesInto(space, nodeId(id))
        .filter((e) => e.parent === group && isMembershipKind(space.profile, e.kind) && (rt.mode === 'store' || isRecordEdge(e)))
        .map((e) => e.id),
    ),
  });

  const checkKind = (rt: SpaceRuntime, kind: EdgeKind | undefined): EdgeKind => {
    const k = kind ?? 'contains';
    if (rt.mode === 'embedded' && k !== 'contains') {
      throw new Error(`Space '${rt.name}' is embedded in the '${rt.field}' field, which can only say 'contains'; kind '${k}' needs a GroupStore space.`);
    }
    return k;
  };

  /** The record members of `group` in an embedded space (the items whose field names it). */
  const recordMembers = (space: GroupSpace, group: NodeId): string[] =>
    edgesOf(space, group).filter((e) => isRecordEdge(e) && recordIds.has(e.child)).map((e) => e.child as string);

  /**
   * Restrict a group-level delta to some members: each member's own part, and the group-level part
   * (the tombstone, re-pointed group edges) only once every member made it — until then the group
   * stays, holding the members that could not be moved.
   */
  const perMember = (full: (space: GroupSpace) => EdgeDelta, members: readonly string[]) => {
    const all = new Set(members);
    return (rt: SpaceRuntime, space: GroupSpace, ids: readonly string[]): EdgeDelta => {
      const delta = full(space);
      if (rt.mode === 'store') return delta;
      return combine(partition(delta, (id) => space.edges.get(id), all), ids, ids.length === all.size, space);
    };
  };

  const notAGroupRecord = (rt: SpaceRuntime, group: string, verb: string): OperationResult<T> | undefined => {
    if (rt.mode !== 'embedded') return undefined;
    if (recordIds.has(group)) {
      return refuse(
        group,
        'unsupported',
        `'${group}' is a record of this collection, and in embedded space '${rt.name}' every record is a node; ${verb} it as a group would leave the record without its node. Untag its members instead, or deleteItem the record.`,
      );
    }
    if (rt.vocabularyNodes.has(group)) {
      return refuse(
        group,
        'unsupported',
        `'${group}' is declared in the vocabulary of embedded space '${rt.name}' (in code); ${verb} it here would not last — it comes back on the next load. Change the vocabulary instead.`,
      );
    }
    return undefined;
  };

  /** Mint ids for a merge: record edges stay record edges (derivable from the field); the rest are unique. */
  const mergeIds = (rt: SpaceRuntime, space: GroupSpace, from: string) => (parent: NodeId, child: NodeId): EdgeId =>
    rt.mode === 'embedded' && space.edges.has(recordEdgeId(from, child)) ? recordEdgeId(parent, child) : uniqueEdgeId(parent, child);

  // ── the facade ────────────────────────────────────────────────────────────
  const tc: TaggedCollection<T> = {
    provider,
    idField,
    spaceNames: names,
    defaultSpace,

    load: () => serialize(loadNow),

    storesLabels: (name) => runtime(name).mode === 'store',

    space(name) {
      if (!loaded) throw new Error('The tagged collection is not loaded yet: `await tc.load()` (or run any operation) first.');
      return runtime(name).current;
    },

    scope(group, opts = {}) {
      const rt = runtime(opts.space);
      if (rt.mode !== 'embedded') {
        throw new Error(`Space '${rt.name}' keeps its edges in a GroupStore, not on the records, so there is no field to filter on. Use closureIds(tc.space('${rt.name}'), group) to get the members.`);
      }
      const g = nodeId(group);
      const space = tc.space(rt.name);
      const value =
        (opts.expand ?? 'closure') === 'closure'
          ? closureIds(space, g).filter((id) => id === g || isGroup(space, id))
          : [g];
      return { field: rt.field!, operator: 'arrayContainsAny', value };
    },

    create(item, opts = {}) {
      return run('create', () => {
        const groups: Record<string, readonly string[]> = Array.isArray(opts.groups)
          ? { [defaultSpace]: opts.groups as readonly string[] }
          : { ...((opts.groups as Record<string, readonly string[]> | undefined) ?? {}) };
        const data: Record<string, unknown> = { ...item };
        for (const [name, gs] of Object.entries(groups)) {
          const rt = runtime(name);
          if (rt.mode === 'embedded') data[rt.field!] = nextField(data[rt.field!], new Set(), gs, rt.fieldOrder);
        }
        const given = data[idField];
        const id = given === undefined || given === null || given === '' ? `${PENDING_ID}${newEpoch()}` : String(given);
        const spaces = [...runtimes.values()].filter((rt) => rt.mode === 'embedded' || groups[rt.name]?.length);
        return {
          operation: 'create',
          units: [{ id, record: { op: 'create', data: data as T } }],
          spaces,
          build: (rt, space, ids) => {
            if (!ids.length) return {};
            const itemId = ids[0]!;
            if (rt.mode === 'store') {
              return { added: [...new Set(groups[rt.name] ?? [])].flatMap((g) => tagDelta(rt, space, [itemId], g, 'contains').added ?? []) };
            }
            return {
              ...(space.nodes.has(nodeId(itemId)) ? {} : { addedNodes: [{ id: nodeId(itemId) }] }),
              added: fieldGroups(data[rt.field!]).map((g) => rt.mintEdge(g, itemId)),
            };
          },
        };
      });
    },

    tag(ids, group, opts = {}) {
      return run('tag', () => {
        const rt = runtime(opts.space);
        const kind = checkKind(rt, opts.kind);
        checkPosition(rt, opts.position);
        const anchor = opts.position?.before ?? opts.position?.after;
        if (anchor !== undefined && !edgesOf(rt.current, nodeId(group)).some((e) => e.child === anchor)) {
          return refuse(anchor, 'notFound', `'${anchor}' is not in '${group}', so nothing can be placed next to it.`);
        }
        return {
          operation: 'tag',
          units: units(ids),
          spaces: [rt],
          build: (r, space, live) => tagDelta(r, space, live, group, kind, opts.position),
        };
      });
    },

    untag(ids, group, opts = {}) {
      return run('untag', () => untagPlan('untag', ids, group, opts.space));
    },

    removeFromGroup(id, group, opts = {}) {
      return run('removeFromGroup', () => untagPlan('removeFromGroup', [id], group, opts.space));
    },

    bulkTag(ids, change) {
      return run('bulkTag', () => {
        const rt = runtime(change.space);
        const kind = checkKind(rt, change.kind);
        const add = [...new Set(change.add ?? [])];
        const remove = [...new Set(change.remove ?? [])];
        const both = add.filter((g) => remove.includes(g));
        if (both.length) throw new Error(`bulkTag: ${both.join(', ')} is both added and removed.`);
        // Labels for groups this change creates. A label equal to the id says nothing new.
        const labels = Object.entries(change.labels ?? {}).filter(([g, label]) => label !== g && add.includes(g));
        if (labels.length && rt.mode === 'embedded') {
          throw new Error(
            `bulkTag: space '${rt.name}' is embedded in the '${rt.field}' field, which stores ids, not labels ` +
              `(${labels.map(([g, l]) => `${g} → ${l}`).join(', ')}); make the id the label, or use a GroupStore space.`,
          );
        }
        /** Label a group only when this change creates it: a label never renames an existing group. */
        const labelDelta = (space: GroupSpace, live: readonly string[]): EdgeDelta => ({
          upsertNodes: live.length
            ? labels.filter(([g]) => !space.nodes.has(nodeId(g))).map(([g, label]) => ({ id: nodeId(g), label }))
            : [],
        });
        return {
          operation: 'bulkTag',
          units: units(ids),
          spaces: [rt],
          build: (r, space, live) =>
            collectEmptied(
              r,
              space,
              concatDeltas([
                labelDelta(space, live),
                ...add.map((g) => tagDelta(r, space, live, g, kind)),
                ...remove.map((g) => untagDelta(r, space, live, g)),
              ]),
            ),
        };
      });
    },

    deleteItem(id) {
      return run('deleteItem', () => ({
        operation: 'deleteItem',
        units: [{ id: String(id), record: { op: 'delete' } }],
        spaces: [...runtimes.values()],
        build: (rt, space, ids) => concatDeltas(ids.map((itemId) => dropItemDelta(rt, space, itemId))),
      }));
    },

    deleteGroup(group, opts = {}) {
      return run('deleteGroup', () => {
        const rt = runtime(opts.space);
        const g = nodeId(group);
        if (!rt.current.nodes.has(g)) return refuse(group, 'notFound', `No group '${group}' in space '${rt.name}'.`);
        const refused = notAGroupRecord(rt, group, 'deleting');
        if (refused) return refused;
        const members = rt.mode === 'embedded' ? recordMembers(rt.current, g) : [];
        return {
          operation: 'deleteGroup',
          units: units(members),
          spaces: [rt],
          subject: group,
          build: perMember((space) => deleteNodeDelta(space, g), members),
        };
      });
    },

    mergeGroups(from, into, opts = {}) {
      return run('mergeGroups', () => {
        if (from === into) throw new Error(`mergeGroups: cannot merge '${from}' into itself.`);
        const rt = runtime(opts.space);
        const f = nodeId(from);
        if (!rt.current.nodes.has(f)) return refuse(from, 'notFound', `No group '${from}' in space '${rt.name}'.`);
        const refused = notAGroupRecord(rt, from, 'merging away');
        if (refused) return refused;
        const members = rt.mode === 'embedded' ? recordMembers(rt.current, f) : [];
        return {
          operation: 'mergeGroups',
          units: units(members),
          spaces: [rt],
          subject: from,
          build: perMember((space) => rankMerge(rt, space, into, mergeDelta(space, f, nodeId(into), { mintId: mergeIds(rt, space, from) })), members),
        };
      });
    },

    renameGroup(group, name, opts = {}) {
      return run('renameGroup', () => {
        const rt = runtime(opts.space);
        const by = opts.by ?? (rt.mode === 'embedded' ? 'id' : 'label');
        const g = nodeId(group);
        const node = rt.current.nodes.get(g);
        if (!node) return refuse(group, 'notFound', `No group '${group}' in space '${rt.name}'.`);
        if (by === 'label') {
          if (rt.mode === 'embedded') {
            throw new Error(`renameGroup: space '${rt.name}' stores group ids in the '${rt.field}' field, so a label cannot be persisted; rename by id.`);
          }
          if (node.label === name) return done(group);
          return {
            operation: 'renameGroup',
            units: [],
            spaces: [rt],
            subject: group,
            build: (_r, space) => (space.nodes.has(g) ? { upsertNodes: [{ id: g, label: name }] } : {}),
          };
        }
        if (name === group) return done(group);
        const refused = notAGroupRecord(rt, group, 'renaming');
        if (refused) return refused;
        if (rt.current.nodes.has(nodeId(name))) {
          return refuse(
            group,
            'groupExists',
            `'${name}' already exists in space '${rt.name}'; renaming '${group}' to it would merge them. If that is meant — or a previous rename was partly applied (some members already moved) — finish it with mergeGroups('${group}', '${name}').`,
          );
        }
        const members = rt.mode === 'embedded' ? recordMembers(rt.current, g) : [];
        const to = nodeId(name);
        return {
          operation: 'renameGroup',
          units: units(members),
          spaces: [rt],
          subject: group,
          build: (r, space, ids) => {
            const live = space.nodes.get(g);
            if (!live) return {};
            // A rename by id is a merge into a new node that keeps the old one's label, payload and
            // family. The new node is created even when only some members move, so a partly applied
            // rename is completed by mergeGroups(from, to) without losing those fields.
            const moved = perMember((s2) => rankMerge(rt, s2, name, mergeDelta(s2, g, to, { mintId: mergeIds(rt, s2, group) })), members)(r, space, ids);
            return space.nodes.has(to) ? moved : concatDeltas([{ addedNodes: [{ ...live, id: to } as Node] }, moved]);
          },
        };
      });
    },

    moveInGroup(id, group, opts) {
      return run('moveInGroup', () => {
        const rt = runtime(opts.space);
        const position: Position = opts.before !== undefined ? { before: opts.before } : { after: opts.after! };
        checkPosition(rt, { before: opts.before, after: opts.after } as Position);
        const anchor = (position.before ?? position.after)!;
        const g = nodeId(group);
        if (!edgesOf(rt.current, g).some((e) => e.child === id)) return refuse(id, 'notFound', `'${id}' is not in '${group}'.`);
        if (anchor === id) return done(id);
        if (!edgesOf(rt.current, g).some((e) => e.child === anchor)) {
          return refuse(anchor, 'notFound', `'${anchor}' is not in '${group}', so nothing can be placed next to it.`);
        }
        return {
          operation: 'moveInGroup',
          units: units([id]),
          spaces: [rt],
          build: (_r, space, ids) => {
            const edge = ids.length ? edgesOf(space, g).find((e) => e.child === ids[0]) : undefined;
            if (!edge) return {};
            const { ordered, reranked } = ranking(space, group, new Set([edge.child as string]));
            const [lo, hi] = slot(ordered, position);
            // Same edge, new rank: removed and re-added under its id, so the inverse restores it exactly.
            return concatDeltas([rerankDelta(reranked), { removed: [edge.id], added: [{ ...edge, order: orderBetween(lo, hi) }] }]);
          },
        };
      });
    },

    revert(inverse) {
      return run('revert', () => revertPlan(inverse));
    },

    subscribe: (listener) => listeners.add(listener),

    operations,
    get commands() {
      return commands;
    },
  };

  function untagPlan(operation: string, ids: readonly string[], group: string, space: string | undefined): Plan<T> {
    const rt = runtime(space);
    return {
      operation,
      units: units(ids),
      spaces: [rt],
      build: (r, s, live) => collectEmptied(r, s, untagDelta(r, s, live, group)),
    };
  }

  function revertPlan(inverse: CollectionInverse<T>): Plan<T> {
    if (!inverse || !Array.isArray(inverse.items) || typeof inverse.shared !== 'object') {
      throw new Error('revert: expected a CollectionInverse ({ items, shared, expect }) returned by an operation.');
    }
    const spaceNames = new Set<string>([...Object.keys(inverse.shared), ...inverse.items.flatMap((i) => Object.keys(i.edges))]);
    if (inverse.items.some((i) => i.record?.op === 'delete')) for (const name of names) spaceNames.add(name);
    const spaces = [...spaceNames].map((n) => runtime(n));
    const ownerIds = new Set(inverse.items.map((i) => i.id));
    const records = new Map(inverse.items.flatMap((i) => (i.record ? [[i.id, i.record] as const] : [])));
    const sharedNode = Object.values(inverse.shared).flatMap((d) => [...(d.upsertNodes ?? []), ...(d.addedNodes ?? []), ...(d.removedNodes ?? [])])[0];
    return {
      operation: 'revert',
      units: inverse.items.map((i) => ({
        id: i.id,
        ...(i.record ? { record: i.record } : {}),
        ...(i.fields ? { fields: i.fields } : {}),
        ...(i.fieldsAfter ? { fieldsAfter: i.fieldsAfter } : {}),
      })),
      // A re-added membership must not bring back a group deleted since (the edge would create it
      // implicitly, past the tombstone guard) — unless the inverse itself restores that group.
      check: (rt, space, delta) => {
        const restored = new Set([...(delta.addedNodes ?? []), ...(delta.upsertNodes ?? [])].map((x) => x.id as string));
        return (delta.added ?? [])
          .filter((e) => !space.nodes.has(e.parent) && !restored.has(e.parent))
          .map((e) => ({
            code: 'conflict' as const,
            edge: e,
            message:
              rt.mode === 'embedded'
                ? `Group '${e.parent}' is gone since this operation — deleted, or emptied (an embedded space keeps a group only while something is in it); undoing would bring it back. Tag the item again if that is meant.`
                : `Group '${e.parent}' was deleted after this operation; undoing it would bring the group back. Re-create the group first if that is meant.`,
          }));
      },
      expectEdges: inverse.expectEdges ?? {},
      spaces,
      expect: inverse.expect ?? {},
      ...(inverse.items.length ? {} : { subject: (sharedNode?.id as string | undefined) ?? 'revert' }),
      build: (rt, space, ids) => {
        const live = ids.filter((id) => ownerIds.has(id));
        const delta = combine(
          {
            items: new Map(inverse.items.flatMap((i) => (i.edges[rt.name] ? [[i.id, i.edges[rt.name]!] as const] : []))),
            shared: inverse.shared[rt.name] ?? {},
          },
          live,
          true,
          space,
        );
        // Undoing a create deletes the record: every membership it has NOW goes with it (as deleteItem
        // does), not only those the create made — or a later tag would outlive its record.
        const deleting = live.filter((id) => records.get(id)?.op === 'delete');
        if (!deleting.length) return rt.mode === 'store' ? alreadyThere(space, delta) : delta;
        const already = new Set<string>(delta.removed ?? []);
        const merged = concatDeltas([delta, ...deleting.map((id) => dropItemDelta(rt, space, id, already))]);
        // A node may be tombstoned by both halves (the item's own node): once is enough.
        const tombstones = new Map((merged.removedNodes ?? []).map((x) => [x.id, x]));
        return { ...merged, ...(tombstones.size ? { removedNodes: [...tombstones.values()] } : {}) };
      },
    };
  }

  /**
   * A store revert re-adding a membership that is already there (someone put it back) is a no-op,
   * not a duplicate. (Embedded spaces decide this by the field check instead: their edge ids are
   * derived from the record, so "already there" is a change someone else made.)
   */
  function alreadyThere(space: GroupSpace, delta: EdgeDelta): EdgeDelta {
    const removing = new Set<string>(delta.removed ?? []);
    const added = (delta.added ?? []).filter(
      (e) =>
        removing.has(e.id) ||
        !(space.edges.has(e.id) || edgesInto(space, e.child).some((x) => !removing.has(x.id) && x.parent === e.parent && x.kind === e.kind)),
    );
    return added.length === (delta.added ?? []).length ? delta : concatDeltas([{ ...delta, added }]);
  }

  const commands = createCommands(tc, { namespace: options.commandNamespace ?? 'groups' });
  return tc;
}

/** Read every record, page by page (a provider may cap an unpaginated list). */
async function readAll<T extends Record<string, unknown>>(provider: DataProvider<T>, pageSize: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { data, total } = await provider.getList({ pagination: { page, pageSize } });
    out.push(...data);
    if (!data.length || data.length < pageSize || out.length >= total) return out;
  }
}

/** Embedded fields must be distinct, not the id field, and (when a schema is given) declared in it. */
function checkFields(runtimes: ReadonlyMap<string, SpaceRuntime>, idField: string, schema: unknown): void {
  const seen = new Map<string, string>();
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
  for (const rt of runtimes.values()) {
    if (rt.mode !== 'embedded') continue;
    const field = rt.field!;
    if (field === idField) throw new Error(`Space '${rt.name}': the embedded field cannot be the id field '${idField}'.`);
    const other = seen.get(field);
    if (other) throw new Error(`Spaces '${other}' and '${rt.name}' both embed their edges in the '${field}' field; give each space its own field.`);
    seen.set(field, rt.name);
    if (shape && typeof shape === 'object' && !(field in shape)) {
      throw new Error(`Space '${rt.name}': the collection's schema has no '${field}' field to embed the edges in (fields: ${Object.keys(shape).join(', ')}).`);
    }
  }
}
