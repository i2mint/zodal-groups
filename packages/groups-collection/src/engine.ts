/**
 * The execution engine: one plan (items + how to build each space's delta), run with per-item
 * failure semantics.
 *
 * The order of every operation, and why:
 *
 * 1. **Read** each item's record (a missing record fails that item). Embedded caches are brought in
 *    step with what was read.
 * 2. **Dry run** every space: `applyDelta` on the current space is a pure validation, so profile
 *    rules, family cardinality and acyclicity are checked BEFORE anything is written. A violation
 *    that belongs to one item (its edge, its node) drops that item and the rest are re-checked; a
 *    violation that belongs to no item (a group-level rule) refuses the whole operation.
 * 3. **Record writes**, item by item (create, delete, or the embedded field). A failed write drops
 *    that item; nothing of it was applied, so nothing needs compensating.
 * 4. **Store writes**, one delta per space for the items still standing, with `expectedRevision`
 *    (and `expectedEpoch`). On `conflict` the space is reloaded, the delta rebuilt from the
 *    operation's intent and re-validated, and the write retried — up to `maxRetries` times. An item
 *    the fresh state refuses, or every item when retries run out, is **compensated**: its record
 *    write undone, its part of earlier spaces' writes inverted.
 * 5. **Embedded caches** take the delta for the items that made it.
 * 6. The **inverse** is split per item, so undoing has the same per-item semantics.
 *
 * Records before edges: the common failure (a record write) then needs no compensation at all;
 * compensation is reserved for a store refusing what the dry run accepted, which only a concurrent
 * writer can cause.
 */

import { applyDelta, type Edge, type EdgeDelta, type EdgeId, type GroupSpace, type Node, type Violation } from '@zodal/groups-core';
import type { DataProvider } from '@zodal/store';
import { combine, isEmptyDelta, partition, sameData } from './delta.js';
import { commit, fieldGroups, isRecordEdge, loadStore, nextField, resyncEmbedded, type SpaceRuntime } from './spaces.js';
import type { CollectionInverse, Failure, ItemInverse, OperationResult, RecordOp } from './types.js';

/** One item of an operation. `id` is replaced by the provider's id after a create without one. */
export interface Unit<T> {
  id: string;
  readonly record?: RecordOp<T>;
  /** Revert only: the fields as they were (see `ItemInverse.fields`). */
  readonly fields?: Readonly<Record<string, { readonly value?: unknown }>>;
}

export interface Plan<T> {
  readonly operation: string;
  /** The items. Empty for a group-level operation (its failure is reported against `subject`). */
  readonly units: readonly Unit<T>[];
  /** The spaces written, in order. */
  readonly spaces: readonly SpaceRuntime[];
  /**
   * The delta for `ids` (a subset of the units' ids) against `current`. Called again after a
   * conflict, so it must compute from the operation's intent, not from a snapshot.
   */
  readonly build: (rt: SpaceRuntime, current: GroupSpace, ids: readonly string[]) => EdgeDelta;
  /** Per space, nodes that must still look like this (a revert never overwrites a newer change). */
  readonly expect?: Readonly<Record<string, readonly Node[]>>;
  readonly subject?: string;
}

export interface EngineContext<T> {
  readonly provider: DataProvider<T>;
  readonly idField: string;
  /** Ids of the records, kept for embedded spaces (a record's node is never collected as an emptied group). */
  readonly recordIds: Set<string>;
  readonly maxRetries: number;
}

type FailureInfo = Omit<Failure, 'id'>;

interface Applied {
  readonly rt: SpaceRuntime;
  readonly delta: EdgeDelta;
  readonly inverse: EdgeDelta;
  readonly before: GroupSpace;
  /** The units this write was made for (the owners its inverse is partitioned by). */
  readonly owners: ReadonlySet<string>;
  /** Units whose part of this write was already undone (compensated). */
  readonly compensated: Set<string>;
}

/** Prefix of the stand-in id of a record created without one (until the provider assigns it). */
export const PENDING_ID = '\u0000pending:';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const emptyInverse = <T>(): CollectionInverse<T> => ({ items: [], shared: {}, expect: {} });

export const isEmptyInverse = (inv: CollectionInverse<unknown>): boolean =>
  inv.items.length === 0 && Object.keys(inv.shared).length === 0;

function violationFailure(violations: readonly Violation[]): FailureInfo {
  return { code: 'violation', reason: violations[0]!.message, violations };
}

/** Run a plan. `changed` says whether anything was written (for change notifications). */
export async function execute<T extends Record<string, unknown>>(
  ctx: EngineContext<T>,
  plan: Plan<T>,
): Promise<{ result: OperationResult<T>; changed: boolean }> {
  const groupLevel = plan.units.length === 0;
  const seen = new Set<string>();
  let units: Unit<T>[] = plan.units.filter((u) => !seen.has(u.id) && seen.add(u.id)).map((u) => ({ ...u }));
  const failed: Failure[] = [];
  const applied: Applied[] = [];
  const undoRecord = new Map<Unit<T>, () => Promise<unknown>>();
  const before = new Map<string, T>();
  let created: T | undefined;

  const ids = (): string[] => units.map((u) => u.id);
  const nothingLeft = (): boolean => (groupLevel ? failed.length > 0 : units.length === 0);
  const drop = (u: Unit<T>, f: FailureInfo): void => {
    failed.push({ id: u.id, ...f });
    units = units.filter((x) => x !== u);
  };
  const dropAll = (f: FailureInfo): void => {
    for (const u of [...units]) drop(u, f);
    if (groupLevel) failed.push({ id: plan.subject ?? '', ...f });
  };

  // ── validation: a pure dry run on the current space ──────────────────────
  const expectViolations = (rt: SpaceRuntime): Violation[] =>
    (plan.expect?.[rt.name] ?? [])
      .filter((n) => !sameData(rt.current.nodes.get(n.id), n))
      .map((n) => ({
        code: 'conflict' as const,
        node: n.id,
        message: `${n.id} changed since this operation (it is now ${JSON.stringify(rt.current.nodes.get(n.id) ?? null)}); undoing it would overwrite that change.`,
      }));

  /** Which items `rt`'s current space refuses: per item, or all of them. Does not mutate `units`. */
  const validate = (rt: SpaceRuntime): { dropped: Array<[Unit<T>, FailureInfo]>; all?: FailureInfo } => {
    let live = [...units];
    const dropped: Array<[Unit<T>, FailureInfo]> = [];
    for (;;) {
      const delta = plan.build(rt, rt.current, live.map((u) => u.id));
      const dry = isEmptyDelta(delta) ? undefined : applyDelta(rt.current, delta);
      const violations = [...expectViolations(rt), ...(dry && !dry.ok ? dry.violations : [])];
      if (!violations.length) return { dropped };
      const byId = new Map(live.map((u) => [u.id, u]));
      const perUnit = new Map<Unit<T>, Violation[]>();
      const rest: Violation[] = [];
      for (const v of violations) {
        const owner = (v.edge && byId.get(v.edge.child)) ?? (v.node !== undefined ? byId.get(v.node) : undefined);
        if (owner && v.code !== 'conflict') perUnit.set(owner, [...(perUnit.get(owner) ?? []), v]);
        else rest.push(v);
      }
      if (rest.length) return { dropped, all: violationFailure(rest) };
      for (const [u, vs] of perUnit) dropped.push([u, violationFailure(vs)]);
      live = live.filter((u) => !perUnit.has(u));
      if (!live.length) return { dropped };
    }
  };

  // ── compensation: undo the applied part of some items ────────────────────
  const edgeLookup = (a: Applied): ((id: EdgeId) => Edge | undefined) => {
    const added = new Map((a.delta.added ?? []).map((e) => [e.id, e]));
    return (id) => a.before.edges.get(id) ?? added.get(id);
  };

  /** Apply a fixed delta to a store space, re-validating it on a fresh state after a conflict. */
  const applyFixed = async (rt: SpaceRuntime, delta: EdgeDelta): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      const out = await commit(rt, delta);
      if (out.kind === 'ok') return true;
      if (out.kind === 'io' || attempt >= ctx.maxRetries) return false;
      await loadStore(rt);
      if (!applyDelta(rt.current, delta).ok) return false;
    }
  };

  /**
   * Undo, for the given units, every store write already made and every record write; then report
   * them failed, each with its own reason. When no unit would remain, the earlier writes are undone
   * whole (their group-level part too).
   */
  const abandon = async (entries: ReadonlyArray<readonly [Unit<T>, FailureInfo]>, groupFailure?: FailureInfo): Promise<void> => {
    const us = entries.map(([u]) => u);
    const everything = groupLevel || units.every((u) => us.includes(u));
    const problems = new Map<Unit<T> | 'group', string>();
    for (const a of [...applied].reverse()) {
      const parts = partition(a.inverse, edgeLookup(a), a.owners);
      const undoIds = (everything ? [...a.owners] : us.map((u) => u.id)).filter((id) => a.owners.has(id) && !a.compensated.has(id));
      const delta = combine(parts, undoIds, everything, a.rt.current);
      if (isEmptyDelta(delta) || (await applyFixed(a.rt, delta))) {
        for (const id of undoIds) a.compensated.add(id);
        if (everything) applied.splice(applied.indexOf(a), 1);
      } else {
        const what = `its edges in space '${a.rt.name}' could not be restored`;
        if (groupLevel) problems.set('group', what);
        for (const u of us) problems.set(u, what);
      }
    }
    for (const u of us) {
      const undo = undoRecord.get(u);
      if (!undo) continue;
      try {
        await undo();
      } catch (e) {
        problems.set(u, `its record could not be restored (${message(e)})`);
      }
    }
    const withProblem = (f: FailureInfo, problem: string | undefined): FailureInfo =>
      problem ? { ...f, reason: `${f.reason} — and ${problem}`, inconsistent: true } : f;
    for (const [u, f] of entries) drop(u, withProblem(f, problems.get(u)));
    if (groupLevel && groupFailure) failed.push({ id: plan.subject ?? '', ...withProblem(groupFailure, problems.get('group')) });
  };
  const abandonAll = (f: FailureInfo): Promise<void> => abandon(units.map((u) => [u, f] as const), f);

  // 1. read ─────────────────────────────────────────────────────────────────
  for (const u of [...units]) {
    if (u.record?.op === 'create') {
      // The DataProvider contract says create rejects an existing id, but older providers overwrite
      // or duplicate: check, so a create never clobbers a record (or its memberships).
      if (u.id.startsWith(PENDING_ID)) continue;
      const exists = await ctx.provider.getOne(u.id).then(
        () => true,
        () => false,
      );
      if (exists) drop(u, { code: 'exists', reason: `A record '${u.id}' already exists; nothing was written.` });
      continue;
    }
    try {
      before.set(u.id, await ctx.provider.getOne(u.id));
    } catch (e) {
      drop(u, { code: 'notFound', reason: `No record '${u.id}' (${message(e)}).` });
    }
  }
  if (before.size) {
    for (const rt of plan.spaces) if (rt.mode === 'embedded') resyncEmbedded(rt, before as Map<string, Record<string, unknown>>);
  }

  // 2. dry run ──────────────────────────────────────────────────────────────
  for (const rt of plan.spaces) {
    if (nothingLeft()) break;
    let checked = validate(rt);
    if (rt.mode === 'store' && (checked.all || checked.dropped.length)) {
      // The refusal may come from our last view of the store, not the store: look again before refusing.
      await loadStore(rt);
      checked = validate(rt);
    }
    for (const [u, f] of checked.dropped) drop(u, f);
    if (checked.all) dropAll(checked.all);
  }

  // 3. record writes ────────────────────────────────────────────────────────
  let patches = new Map<string, Record<string, unknown>>();
  if (!nothingLeft()) {
    patches = fieldPatches(plan, units, before, ids);
    for (const u of [...units]) {
      try {
        if (u.record?.op === 'create') {
          const record = await ctx.provider.create(u.record.data);
          const id = String(record[ctx.idField]);
          u.id = id;
          created = record;
          ctx.recordIds.add(id);
          undoRecord.set(u, async () => {
            await ctx.provider.delete(id);
            ctx.recordIds.delete(id);
          });
        } else if (u.record?.op === 'delete') {
          const prev = before.get(u.id)!;
          await ctx.provider.delete(u.id);
          ctx.recordIds.delete(u.id);
          undoRecord.set(u, async () => {
            await ctx.provider.create(prev);
            ctx.recordIds.add(u.id);
          });
        } else {
          const patch = patches.get(u.id);
          if (patch) {
            const prev = before.get(u.id)!;
            const restore = Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k]])) as Partial<T>;
            await ctx.provider.update(u.id, patch as Partial<T>);
            undoRecord.set(u, () => ctx.provider.update(u.id, restore));
          }
        }
      } catch (e) {
        drop(u, { code: 'recordWrite', reason: `Writing record '${u.id}' failed: ${message(e)}` });
      }
    }
  }

  // 4. store writes, retried on conflict ────────────────────────────────────
  for (const rt of plan.spaces) {
    if (rt.mode !== 'store') continue;
    for (let retries = 0; !nothingLeft(); ) {
      const delta = plan.build(rt, rt.current, ids());
      if (isEmptyDelta(delta)) break;
      const out = await commit(rt, delta);
      if (out.kind === 'ok') {
        applied.push({ rt, delta, inverse: out.inverse, before: out.before, owners: new Set(ids()), compensated: new Set() });
        break;
      }
      if (out.kind === 'io') {
        await abandonAll({ code: 'storeWrite', reason: `Space '${rt.name}': the store write failed: ${message(out.error)}` });
        break;
      }
      if (retries++ >= ctx.maxRetries) {
        await abandonAll(
          out.kind === 'conflict'
            ? { code: 'conflict', reason: `Space '${rt.name}': still conflicting with other writers after ${ctx.maxRetries} retries.`, violations: out.violations }
            : violationFailure(out.violations),
        );
        break;
      }
      // Someone else wrote: rebuild from the operation's intent on the fresh state, re-validate.
      await loadStore(rt);
      const { dropped, all } = validate(rt);
      if (all) {
        await abandonAll(all);
        break;
      }
      if (dropped.length) await abandon(dropped);
    }
  }

  // 5. embedded caches ──────────────────────────────────────────────────────
  for (const rt of plan.spaces) {
    if (rt.mode !== 'embedded' || nothingLeft()) continue;
    const delta = plan.build(rt, rt.current, ids());
    if (isEmptyDelta(delta)) continue;
    const out = await commit(rt, delta);
    if (out.kind === 'ok') applied.push({ rt, delta, inverse: out.inverse, before: out.before, owners: new Set(ids()), compensated: new Set() });
  }

  // 6. the inverse, split per item ──────────────────────────────────────────
  const finalIds = new Set(ids());
  const items = new Map<string, { id: string; record?: RecordOp<T>; edges: Record<string, EdgeDelta>; fields?: Record<string, { value?: unknown }> }>();
  for (const u of units) {
    const record: RecordOp<T> | undefined =
      u.record?.op === 'create' ? { op: 'delete' } : u.record?.op === 'delete' ? { op: 'create', data: before.get(u.id)! } : undefined;
    const patch = patches.get(u.id);
    const fields = patch && !u.record ? priorFields(before.get(u.id)!, Object.keys(patch)) : undefined;
    items.set(u.id, { id: u.id, ...(record ? { record } : {}), edges: {}, ...(fields ? { fields } : {}) });
  }
  const shared: Record<string, EdgeDelta> = {};
  const expect: Record<string, Node[]> = {};
  for (const a of applied) {
    // Partitioned by the units the write was made for: a compensated unit's part is already undone.
    const parts = partition(a.inverse, edgeLookup(a), a.owners);
    for (const [id, part] of parts.items) if (finalIds.has(id) && !isEmptyDelta(part)) items.get(id)!.edges[a.rt.name] = part;
    if (!isEmptyDelta(parts.shared)) shared[a.rt.name] = parts.shared;
    const after = (a.inverse.upsertNodes ?? []).flatMap((n) => {
      const live = a.rt.current.nodes.get(n.id);
      return live ? [live] : [];
    });
    if (after.length) expect[a.rt.name] = after;
  }
  const inverse: CollectionInverse<T> = {
    items: [...items.values()].filter((i) => i.record || Object.keys(i.edges).length) as ItemInverse<T>[],
    shared,
    expect,
  };

  // A group operation names its group as succeeded iff the group-level change applied (no member was left behind).
  const subject = plan.subject !== undefined && !failed.length ? [plan.subject] : [];
  const succeeded = groupLevel ? subject : [...ids(), ...subject];
  const result: OperationResult<T> = {
    ok: failed.length === 0,
    succeeded,
    // A create that never reached the provider has no id yet: report it as ''.
    failed: failed.map((f) => (f.id.startsWith(PENDING_ID) ? { ...f, id: '' } : f)),
    inverse,
    ...(created && finalIds.has(String(created[ctx.idField])) ? { record: created } : {}),
  };
  return { result, changed: !isEmptyInverse(inverse) };
}

/**
 * The embedded field writes, per item: the record's current field, minus the groups its record
 * edges leave, plus the groups they join. Computed from the record (the source of truth), so order
 * and entries this package does not understand survive. Items with a record op carry their fields
 * in the record itself.
 */
function fieldPatches<T extends Record<string, unknown>>(
  plan: Plan<T>,
  units: readonly Unit<T>[],
  before: ReadonlyMap<string, T>,
  ids: () => string[],
): Map<string, Record<string, unknown>> {
  const patches = new Map<string, Record<string, unknown>>();
  const plain = new Set(units.filter((u) => !u.record).map((u) => u.id));
  const hints = new Map(units.flatMap((u) => (u.fields ? [[u.id, u.fields] as const] : [])));
  for (const rt of plan.spaces) {
    if (rt.mode !== 'embedded') continue;
    const space = rt.current;
    const delta = plan.build(rt, space, ids());
    const parts = partition(delta, (id) => space.edges.get(id), plain);
    for (const [id, part] of parts.items) {
      const leave = (part.removed ?? [])
        .map((eid) => space.edges.get(eid))
        .filter((e): e is Edge => !!e && isRecordEdge(e) && e.child === id)
        .map((e) => e.parent as string);
      const join = (part.added ?? []).filter((e) => isRecordEdge(e) && e.child === id).map((e) => e.parent as string);
      if (!leave.length && !join.length) continue;
      const current = before.get(id)?.[rt.field!];
      let next: unknown = nextField(current, new Set(leave), join);
      // A revert carries the field as it was: write it verbatim when it says the same thing (order survives undo).
      const hint = hints.get(id)?.[rt.field!];
      if (hint && sameGroups(hint.value, next)) next = hint.value;
      if (sameData(current, next)) continue;
      patches.set(id, { ...(patches.get(id) ?? {}), [rt.field!]: next });
    }
  }
  return patches;
}

/** Do two field values name the same groups (as sets)? */
function sameGroups(a: unknown, b: unknown): boolean {
  const x = new Set(fieldGroups(a));
  const y = fieldGroups(b);
  return x.size === new Set(y).size && y.every((g) => x.has(g));
}

/** The fields' values before a write, absent fields as `{}` (JSON keeps the difference). */
function priorFields(record: Record<string, unknown>, keys: readonly string[]): Record<string, { value?: unknown }> {
  return Object.fromEntries(keys.map((k) => [k, record[k] === undefined ? {} : { value: record[k] }]));
}
