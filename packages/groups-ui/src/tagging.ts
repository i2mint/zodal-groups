/**
 * Selection-level tagging — Gmail's label menu, as a headless descriptor.
 *
 * Select twelve items, open "Labels": each group shows a checkbox that is **checked** when every
 * selected item is in it, **empty** when none is, and **mixed** (a dash) when some are. Clicking
 * stages a change; nothing is written until "Apply to N items". The UI research found this the
 * operation that most needed a descriptor (polytag `ui-patterns.md` §2.2, view contract M5), because
 * everything a renderer needs is a computation over the model, not over the DOM:
 *
 * - **the tri-state** per group over the selection (direct memberships, membership kinds only);
 * - **the click cycle** — Gmail's: a mixed box goes to *all* (the user's intent is almost always
 *   "apply this to everything I selected"), *all* goes to *none*, *none* to *all*. With
 *   `restoreMixed` a once-mixed box can cycle back to *some* (unchanged), the APG mixed-checkbox
 *   cycle;
 * - **why a group would be refused** — a dry run of exactly what Apply would write, through the
 *   model's own validator (`validateEdge`, and `applyDelta` where a family rule could apply), so the
 *   menu can say *"“Status” allows one value per item…"* before the click rather than after the
 *   write. Refusals are judged against the space with the staged *removals* applied, so the
 *   exclusive-family switch (untick `Todo`, tick `Doing`) is allowed; staged additions that clash
 *   with each other are reported as plan-level **conflicts** and block Apply;
 * - **the plan** — `{ add: [{ group, ids }], remove: [{ group, ids }] }`, plus the same changes as
 *   `bulkTag`-shaped batches. This module never writes: it returns the plan, and the caller hands
 *   it to `@zodal/groups-collection` (`bulkTag` / `tag` / `untag`), a `GroupStore` (`planToDelta`),
 *   or a `Groups` handle (`applyTagging`). groups-ui stays store-free.
 *
 * Two layers, the usual split. The pure functions (`toTaggingView`, `toggleTag`, `createTag`,
 * `setTagQuery`, `resetTag`) thread an immutable `TaggingState`; `createTaggingSession` wraps them
 * with a cache and a change subscription, for a renderer (and for `useSyncExternalStore`: `view()`
 * returns the same object until something changes).
 *
 * @see `docs/research/_reconciliation.md` (D15, D16, D26, D29, §4) and issue #3.
 */

import {
  CONTAINS,
  ancestors,
  applyDelta,
  edgeId,
  edgesInto,
  edgesOf,
  hasFamilyAtOrAbove,
  isGroup,
  isMembershipKind,
  makeEdge,
  nodeId,
  primaryPath,
  validateEdge,
  type Edge,
  type EdgeDelta,
  type EdgeId,
  type EdgeKind,
  type GroupSpace,
  type Groups,
  type Node,
  type NodeId,
  type Result,
  type Violation,
} from '@zodal/groups-core';
import {
  explainViolation,
  explainViolations,
  labelFor,
  resolveMessages,
  sentence,
  type ExplainedViolation,
  type GroupsUiMessages,
  type LabelOf,
  type MessagesOverride,
} from './messages.js';

// ── types ───────────────────────────────────────────────────────────────────

/** A group's state over the selection: in none of it, some of it, or all of it. */
export type TagState = 'none' | 'some' | 'all';

/**
 * Where the space comes from: a `GroupSpace`, anything holding one live (a `Groups` handle), or a
 * getter (`() => collection.space('tags')`). Re-read on every view, so a session follows the model.
 */
export type SpaceSource<P = unknown> = GroupSpace<P> | { readonly space: GroupSpace<P> } | (() => GroupSpace<P>);

/** An item the dry run says the model would refuse to put in a group. */
export interface Refusal {
  readonly id: NodeId;
  readonly group: NodeId;
  readonly violations: readonly Violation[];
  /** The first violation, as a sentence and a fix. */
  readonly explained: ExplainedViolation;
}

/** One group in the menu. Keyed by `group` (a menu row is a model fact: each group appears once). */
export interface TagRow {
  readonly key: string;
  readonly group: NodeId;
  readonly label: string;
  /** The group's primary path (`Projects / Q3`) when it is nested; for display and search. */
  readonly path?: string;
  /** The staged state — what Apply would leave. */
  readonly state: TagState;
  /** The state now, before anything staged. */
  readonly originalState: TagState;
  /** How many selected items are in the group now. */
  readonly count: number;
  /** The selection size. */
  readonly total: number;
  /** The state differs from the original. */
  readonly pending: boolean;
  /** Created in this menu; Apply creates it. */
  readonly isNew: boolean;
  /** What a click does next (`toggleTag`). Equal to `state` when nothing can change. */
  readonly next: TagState;
  /** No click can change this row: adding is refused for every item and removing is refused too. */
  readonly disabled: boolean;
  /** Why adding (or removing) is refused, whole or in part — the sentence to render inline. */
  readonly reason?: string;
  /** The suggested fix that goes with `reason`. */
  readonly fix?: string;
  /** Items that would be refused if this group were applied to all of the selection. */
  readonly refused: readonly Refusal[];
  /** Why removing it from the selection would be refused (a group that would become an item). */
  readonly removalViolations: readonly ExplainedViolation[];
  /** A staged change on this row clashes with another staged change; see the plan's `conflicts`. */
  readonly conflict?: string;
  /** The staged change in items: how many Apply would add to it, and remove from it. */
  readonly change: { readonly add: number; readonly remove: number };
  readonly aria: {
    readonly checked: 'true' | 'false' | 'mixed';
    readonly disabled: boolean;
    /** The accessible name: label (or path) and "7 of 12". */
    readonly label: string;
    /** The accessible description: the reason, the fix, a conflict. */
    readonly description?: string;
  };
}

/** The "Create “…”" affordance, offered when the search text names no existing group. */
export interface CreateOption {
  readonly label: string;
  /** The id the new group will get (`mintGroupId(label)`). */
  readonly group: NodeId;
  readonly allowed: boolean;
  readonly reason?: string;
  /** The option's text, e.g. `Create “Reading”`. */
  readonly text: string;
}

export interface GroupChange {
  readonly group: NodeId;
  readonly ids: readonly NodeId[];
}

/** The same change for several items — one `collection.bulkTag(ids, change)` call. */
export interface TaggingBatch {
  readonly ids: readonly NodeId[];
  readonly change: {
    readonly add: readonly NodeId[];
    readonly remove: readonly NodeId[];
    readonly kind?: EdgeKind;
    /** Labels of the groups this batch creates, where a label differs from the id (`bulkTag`'s `labels`). */
    readonly labels?: Readonly<Record<string, string>>;
  };
}

/** What Apply writes. Plain data: hand it to the collection, a store, or a `Groups` handle. */
export interface TaggingPlan {
  /** Per group, the items to put in it (the ones not in it yet, minus refusals). */
  readonly add: readonly GroupChange[];
  /** Per group, the items to take out of it. */
  readonly remove: readonly GroupChange[];
  /** Groups created in the menu. Tagging creates a missing group; this says which, with its label. */
  readonly create: readonly { readonly group: NodeId; readonly label: string }[];
  /** The edge kind added memberships get. */
  readonly kind: EdgeKind;
  /** (item, group) pairs left out of `add` because the model would refuse them. Never silent: announce them. */
  readonly refused: readonly Refusal[];
  /** Staged changes that clash with each other (two values of an exclusive family). Apply is blocked. */
  readonly conflicts: readonly ExplainedViolation[];
  /**
   * The same plan as `collection.bulkTag(ids, change)` calls. One batch when nothing was refused
   * (one inverse, one undo step); otherwise items with the same change share a batch.
   */
  readonly batches: readonly TaggingBatch[];
  /** How many distinct items Apply would change — the N of "Apply to N items". */
  readonly itemCount: number;
  readonly isEmpty: boolean;
  /** Nothing blocks Apply (no conflicts). */
  readonly ok: boolean;
  /**
   * The revision of the space the plan was computed against. A `GroupStore` write can pass it as
   * `expectedRevision`, so a plan made stale by another writer is refused (`conflict`) instead of
   * applied; `complete` also checks the result row by row.
   */
  readonly revision: number;
}

/** The staged state. Immutable; the pure functions return a new one. */
export interface TaggingState {
  /** Per group, the staged target state. A group absent here is unchanged. */
  readonly pending: ReadonlyMap<NodeId, 'all' | 'none'>;
  readonly created: readonly { readonly group: NodeId; readonly label: string }[];
  /** The search text, exactly as typed. Never cleared by an apply. */
  readonly query: string;
}

export const EMPTY_TAGGING_STATE: TaggingState = Object.freeze({
  pending: new Map<NodeId, 'all' | 'none'>(),
  created: [],
  query: '',
});

export interface TaggingOptions {
  /** The selected items. Order is kept (it is the order of `ids` in the plan); duplicates are dropped. */
  readonly selection: Iterable<NodeId | string>;
  /**
   * The groups the menu offers. Default: every node that is a group (has members), plus the values
   * of every family (a family root's children, which may have no members yet), minus the selection.
   * Pass a vocabulary (a collection's declared groups) to list empty groups too.
   */
  readonly candidates?: Iterable<NodeId | string> | ((space: GroupSpace) => Iterable<NodeId | string>);
  /** Keep only the groups this accepts (e.g. hide family roots). Groups created in the menu always stay. */
  readonly filter?: (group: NodeId, space: GroupSpace) => boolean;
  /** The edge kind new memberships get. Default `contains`. */
  readonly kind?: EdgeKind;
  /** Offer "Create “…”" for search text that names no group. Default `true` (the profile may still refuse). */
  readonly allowCreate?: boolean;
  /** The id of a group created from a typed name. Default: the trimmed name itself. */
  readonly mintGroupId?: (label: string, space: GroupSpace) => string;
  /** How to label a node — an item's title, say. Falls back to the node's label, then its id. */
  readonly labelOf?: LabelOf;
  readonly messages?: MessagesOverride;
  /**
   * The APG mixed-checkbox cycle: a group that started mixed cycles some → all → none → some, so the
   * user can get back to "leave it as it is". Default `false`: Gmail's some → all → none → all
   * (`resetTag` still restores a row).
   */
  readonly restoreMixed?: boolean;
  /** Row order. Default: by path (or label), with a locale-aware, numeric collator. */
  readonly compare?: (a: TagRow, b: TagRow) => number;
}

/** Everything a renderer draws. */
export interface TaggingView {
  /** The rows the search lets through, in order. */
  readonly rows: readonly TagRow[];
  /** Every row, search or not (staged changes on hidden rows still apply). */
  readonly allRows: readonly TagRow[];
  readonly query: string;
  readonly selection: readonly NodeId[];
  /** Offered when the search text names no group. */
  readonly create?: CreateOption;
  readonly plan: TaggingPlan;
  /** The staged changes as sentences: `Add “Reading” to 7 items`, `Remove “Inbox” from 12 items`. */
  readonly summary: readonly string[];
  /** `Apply to 7 items`. */
  readonly applyLabel: string;
  readonly canApply: boolean;
  /** Why there are no rows to show (no selection, no match, no groups). */
  readonly empty?: string;
  /** Why Apply would do nothing now (no selection, nothing staged, a conflict). Absent when it can apply. */
  readonly blocked?: string;
  /**
   * Something the user must be told once, that no row shows — staged changes a selection change
   * discarded. Present in the first view after it happened, gone after the next change.
   */
  readonly notice?: string;
  readonly messages: GroupsUiMessages;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** The space a source holds now. */
export function resolveSpace<P>(source: SpaceSource<P>): GroupSpace<P> {
  if (typeof source === 'function') return source();
  if ('nodes' in source && 'edges' in source) return source as GroupSpace<P>;
  return (source as { readonly space: GroupSpace<P> }).space;
}

const unique = (ids: Iterable<NodeId | string>): NodeId[] => {
  const seen = new Set<NodeId>();
  for (const id of ids) seen.add(nodeId(String(id)));
  return [...seen];
};

/** Case- and accent-insensitive form for search. */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byPath = (a: TagRow, b: TagRow): number => collator.compare(a.path ?? a.label, b.path ?? b.label);

const stateOf = (count: number, total: number): TagState =>
  count === 0 ? 'none' : count >= total ? 'all' : 'some';

/** A dry-run edge id. Never written; distinct from any minted id so `edgeIdExists` cannot fire. */
const dryId = (group: NodeId, item: NodeId) => edgeId(`\u0000dry:${group}>${item}`);

/** The membership edges between `group` and `item` (any membership kind). */
const membershipEdges = (space: GroupSpace, group: NodeId, item: NodeId): Edge[] =>
  edgesInto(space, item).filter((e) => e.parent === group && isMembershipKind(space.profile, e.kind));

/** The default candidates: groups, plus family values (which may have no members yet), minus the selection. */
function defaultCandidates(space: GroupSpace, selection: ReadonlySet<NodeId>): NodeId[] {
  const out = new Set<NodeId>();
  for (const [id, node] of space.nodes) {
    if (isGroup(space, id)) out.add(id);
    if (node.family) {
      for (const e of edgesOf(space, id)) if (space.profile.edgeKinds[e.kind]?.transitive) out.add(e.child);
    }
  }
  for (const id of selection) out.delete(id);
  return [...out];
}

/**
 * The cycle. Try the natural next state, then fall back to the original (restoring is always
 * allowed); `current` comes back when nothing else is possible — the row is disabled.
 */
function nextState(
  original: TagState,
  current: TagState,
  can: { readonly add: boolean; readonly remove: boolean },
  restoreMixed: boolean,
): TagState {
  const order: TagState[] =
    current === 'all'
      ? ['none']
      : current === 'none'
        ? restoreMixed && original === 'some'
          ? ['some', 'all']
          : ['all']
        : ['all', 'none'];
  const allowed = (s: TagState): boolean =>
    s === original || (s === 'all' ? can.add : s === 'none' ? can.remove : false);
  for (const s of [...order, original]) if (s !== current && allowed(s)) return s;
  return current;
}

// ── the core computation ────────────────────────────────────────────────────

interface Core {
  readonly allRows: readonly TagRow[];
  readonly plan: TaggingPlan;
  readonly summary: readonly string[];
}

/** One row's computed part, reusable while its key holds (see `rowKey`). */
interface RowEntry {
  readonly key: string;
  readonly row: TagRow;
  readonly addIds: readonly NodeId[];
  readonly removeIds: readonly NodeId[];
}

/**
 * Per-row results, valid for ONE (space, selection, options): the session drops it when any of
 * them changes. A toggle then recomputes only the rows it can affect.
 */
export type RowCache = Map<NodeId, RowEntry>;

function computeCore(
  space: GroupSpace,
  selection: readonly NodeId[],
  state: Pick<TaggingState, 'pending' | 'created'>,
  options: TaggingOptions,
  messages: GroupsUiMessages,
  cache: RowCache = new Map(),
): Core {
  const kind = options.kind ?? CONTAINS;
  const total = selection.length;
  const explainOpts = {
    space,
    messages: messages.violations,
    ...(options.labelOf ? { labelOf: options.labelOf } : {}),
  };
  const createdLabel = new Map(state.created.map((c) => [c.group, c.label] as const));
  const label = (id: NodeId): string => createdLabel.get(id) ?? labelFor(id, explainOpts);

  // Which selected items each group holds now (direct memberships, membership kinds only).
  const membersOf = new Map<NodeId, Set<NodeId>>();
  for (const item of selection) {
    for (const e of edgesInto(space, item)) {
      if (!isMembershipKind(space.profile, e.kind)) continue;
      let set = membersOf.get(e.parent);
      if (!set) membersOf.set(e.parent, (set = new Set()));
      set.add(item);
    }
  }

  // The candidates, then the groups created in the menu (never filtered away).
  const selectionSet = new Set(selection);
  const raw =
    options.candidates === undefined
      ? defaultCandidates(space, selectionSet)
      : unique(typeof options.candidates === 'function' ? options.candidates(space) : options.candidates);
  const groups = unique([
    ...(options.filter ? raw.filter((g) => options.filter!(g, space)) : raw),
    ...state.created.map((c) => c.group),
  ]);

  // Removals first: refusals are judged with every staged removal applied, so "untick Todo, tick
  // Doing" in an exclusive family is a legal switch rather than a refused second value.
  const removalEdges = (group: NodeId): Edge[] =>
    [...(membersOf.get(group) ?? [])].flatMap((item) => membershipEdges(space, group, item));
  const removing = [...state.pending].filter(([, target]) => target === 'none').map(([g]) => g).sort();
  let removedBase: Result<GroupSpace> | null | undefined;
  /** The space with every staged removal applied — computed only if a row needs it. */
  const base = (): GroupSpace => {
    if (removedBase === undefined) {
      const removed = removing.flatMap((g) => removalEdges(g).map((e) => e.id));
      removedBase = removed.length ? applyDelta(space, { removed }) : null;
    }
    return removedBase?.ok ? removedBase.value : space;
  };

  // Which staged removals can change a row's refusals. With per-item caps, or a selection holding
  // groups, any of them can (parent counts, nesting). Otherwise only removals inside a family
  // (a family counts values per item); a row with no family above it is affected by none.
  const p = space.profile;
  const anyRemovalCounts =
    p.maxParentsPerItem !== null || p.maxGroupsPerItem !== null || selection.some((item) => isGroup(space, item));
  const familyRemovals = removing.filter((g) => hasFamilyAtOrAbove(space, g));
  const removalKey = (group: NodeId): string =>
    anyRemovalCounts ? removing.join('\u0000') : hasFamilyAtOrAbove(space, group) ? familyRemovals.join('\u0000') : '';

  /** A refusal whose sentence is built only when read: thousands may be refused, few are shown. */
  const refusal = (id: NodeId, group: NodeId, violations: readonly Violation[]): Refusal => {
    let explained: ExplainedViolation | undefined;
    return {
      id,
      group,
      violations,
      get explained() {
        return (explained ??= explainViolation(violations[0]!, explainOpts));
      },
    };
  };

  /** Which of `lacking` the model would refuse to put in `group` — the dry run of Apply. */
  const addRefusals = (group: NodeId, lacking: readonly NodeId[], against: GroupSpace): Refusal[] => {
    const out: Refusal[] = [];
    const passing: Edge[] = [];
    for (const item of lacking) {
      const edge = makeEdge(group, item, { kind, id: dryId(group, item) });
      const violations = validateEdge(against, edge);
      if (violations.length) out.push(refusal(item, group, violations));
      else passing.push(edge);
    }
    // Family rules depend on the end state; only pay for a full dry run where one could apply.
    if (passing.length && hasFamilyAtOrAbove(against, group)) {
      const result = applyDelta(against, { added: passing });
      if (!result.ok) {
        const byItem = new Map<NodeId, Violation[]>();
        const general: Violation[] = [];
        const passingIds = new Set(passing.map((e) => e.child));
        for (const v of result.violations) {
          const who = v.code === 'maxPerFamily' ? v.node : v.edge?.child;
          if (who && passingIds.has(who)) byItem.set(who, [...(byItem.get(who) ?? []), v]);
          else general.push(v);
        }
        for (const edge of passing) {
          const vs = byItem.get(edge.child) ?? (general.length ? general : undefined);
          if (vs) out.push(refusal(edge.child, group, vs));
        }
      }
    }
    return out;
  };

  /** Taking the selection out of `group` is refused only when it empties the group (D29). */
  const removalRefusals = (group: NodeId): ExplainedViolation[] => {
    const all = edgesOf(space, group).filter((e) => isMembershipKind(space.profile, e.kind));
    const leaving = removalEdges(group);
    if (!leaving.length || leaving.length < all.length) return [];
    const result = applyDelta(space, { removed: leaving.map((e) => e.id) });
    return result.ok ? [] : explainViolations(result.violations, explainOpts);
  };

  const computeRow = (group: NodeId, key: string, current: TagState | undefined): RowEntry => {
    const members = membersOf.get(group) ?? new Set<NodeId>();
    const count = members.size;
    const originalState = total === 0 ? 'none' : stateOf(count, total);
    const lacking = selection.filter((item) => !members.has(item));
    const rk = removalKey(group);
    const refused = total === 0 ? [] : addRefusals(group, lacking, rk ? base() : space);
    const removalViolations = count ? removalRefusals(group) : [];
    const can = {
      add: total > 0 && (lacking.length === 0 || refused.length < lacking.length),
      remove: removalViolations.length === 0,
    };
    const now = current ?? originalState;
    const next = nextState(originalState, now, can, options.restoreMixed === true);
    const refusedIds = new Set(refused.map((r) => r.id));
    const addIds = now === 'all' ? lacking.filter((item) => !refusedIds.has(item)) : [];
    const removeIds = now === 'none' ? [...members] : [];

    // The sentence to show: a total refusal of the next step, else a partial refusal of "all".
    let reason: string | undefined;
    let fix: string | undefined;
    const blockedAdd = !can.add && now !== 'all' && refused.length > 0;
    const blockedRemove = !can.remove && now !== 'none';
    if (next === now && (blockedAdd || blockedRemove)) {
      const e = blockedAdd ? refused[0]!.explained : removalViolations[0]!;
      reason = e.message;
      fix = e.fix;
    } else if (refused.length && originalState !== 'all') {
      const e = refused[0]!.explained;
      reason =
        refused.length === lacking.length
          ? e.message
          : messages.tagging.partlyRefused(refused.length, lacking.length, e.message);
      fix = e.fix;
    } else if (blockedRemove) {
      reason = removalViolations[0]!.message;
      fix = removalViolations[0]!.fix;
    }

    const node = space.nodes.get(group);
    const nested = node ? primaryPath(space, group) : undefined;
    const path = nested && nested.path.length > 1 ? nested.path.map(label).join(' / ') : undefined;
    const base_ = {
      key: group,
      group,
      label: label(group),
      ...(path ? { path } : {}),
      state: now,
      originalState,
      count,
      total,
      pending: now !== originalState,
      isNew: createdLabel.has(group) && !node,
      next,
      disabled: next === now,
      ...(reason ? { reason } : {}),
      ...(fix ? { fix } : {}),
      refused,
      removalViolations,
      change: { add: addIds.length, remove: removeIds.length },
    };
    // The description is the reason and its fix. A conflict is NOT repeated here: it belongs to
    // the plan (and is said once, where Apply is), see `TagRow.conflict`.
    const description = [reason, fix].filter(Boolean).join(' ');
    const row: TagRow = {
      ...base_,
      aria: {
        checked: now === 'all' ? 'true' : now === 'none' ? 'false' : 'mixed',
        disabled: base_.disabled,
        label: messages.tagging.rowLabel(base_),
        ...(description ? { description } : {}),
      },
    };
    return { key, row, addIds, removeIds };
  };

  // Each row is reused while its key holds: its staged state, the removals that can affect it,
  // and its created label.
  const entries = groups.map((group) => {
    const current = state.pending.get(group);
    const key = `${current ?? '-'}\u0001${removalKey(group)}\u0001${createdLabel.get(group) ?? ''}`;
    const hit = cache.get(group);
    if (hit && hit.key === key) return hit;
    const entry = computeRow(group, key, current);
    cache.set(group, entry);
    return entry;
  });

  const add: GroupChange[] = entries.filter((d) => d.addIds.length).map((d) => ({ group: d.row.group, ids: d.addIds }));
  const remove: GroupChange[] = entries
    .filter((d) => d.removeIds.length)
    .map((d) => ({ group: d.row.group, ids: d.removeIds }));
  const refused = entries.filter((d) => d.row.state === 'all' && d.row.pending).flatMap((d) => d.row.refused);
  const create = state.created
    .filter((c) => add.some((a) => a.group === c.group) && !space.nodes.has(c.group))
    .map((c) => ({ group: c.group, label: c.label }));

  // The staged removals the model refuses on their own (a write elsewhere since they were staged).
  // Rows were judged against the current space then; say so rather than falling back silently.
  const conflictViolations: Violation[] = [];
  if (removing.length && anyRowUsesBase(entries)) {
    base();
    if (removedBase && !removedBase.ok) conflictViolations.push(...removedBase.violations);
  }
  // The whole plan, dry-run at once: catches staged changes that clash with EACH OTHER.
  if (add.length || remove.length) {
    const result = applyDelta(space, deltaOf(space, { add, remove, create, kind }, dryId));
    if (!result.ok) conflictViolations.push(...result.violations);
  }
  const conflicts = explainViolations(conflictViolations, explainOpts);

  // Which rows a conflict is about: the group an edge goes into, or — for a family — the staged
  // groups that reach one of the clashing values.
  const conflictOf = new Map<NodeId, string>();
  for (const v of conflictViolations) {
    const text = sentence(explainViolation(v, explainOpts));
    const involved = new Set<NodeId>();
    if (v.edge) involved.add(v.edge.parent);
    if (v.code === 'maxPerFamily' && v.values) {
      for (const a of add) {
        if (v.values.includes(a.group) || v.values.some((value) => ancestors(space, a.group).has(value))) {
          involved.add(a.group);
        }
      }
    }
    for (const g of involved) if (!conflictOf.has(g)) conflictOf.set(g, text);
  }

  // Batches, for `bulkTag(ids, change)`. They must write EXACTLY the plan: `bulkTag` skips an
  // item only when it already has an edge of the SAME kind, so an item already in a group through
  // another membership kind (`is_a`) would get a second edge, and a refused item would be failed
  // whole. One batch is exact when every changing item either takes every added group or already
  // holds it with this kind (removing a group an item is not in is a no-op too); then it is one
  // call, one inverse, one undo step. Otherwise items with the same change share a batch.
  const perItem = new Map<NodeId, { add: NodeId[]; remove: NodeId[] }>();
  const touch = (id: NodeId) => perItem.get(id) ?? perItem.set(id, { add: [], remove: [] }).get(id)!;
  for (const a of add) for (const id of a.ids) touch(id).add.push(a.group);
  for (const r of remove) for (const id of r.ids) touch(id).remove.push(r.group);
  const changing = selection.filter((item) => perItem.has(item));
  const labelsFor = (adds: readonly NodeId[]) => {
    const labels: Record<string, string> = {};
    for (const c of create) if (c.label !== c.group && adds.includes(c.group)) labels[c.group] = c.label;
    return Object.keys(labels).length ? { labels } : {};
  };
  const changeOf = (adds: NodeId[], removes: NodeId[]) => ({
    add: adds,
    remove: removes,
    ...(kind !== CONTAINS ? { kind } : {}),
    ...labelsFor(adds),
  });
  let batches: TaggingBatch[];
  const sameKindIn = (group: NodeId, item: NodeId) =>
    edgesInto(space, item).some((e) => e.parent === group && e.kind === kind);
  const uniform = add.every((a) => {
    const taking = new Set(a.ids);
    return changing.every((item) => taking.has(item) || sameKindIn(a.group, item));
  });
  if (uniform) {
    batches = changing.length ? [{ ids: changing, change: changeOf(add.map((a) => a.group), remove.map((r) => r.group)) }] : [];
  } else {
    const batchesByKey = new Map<string, { ids: NodeId[]; add: NodeId[]; remove: NodeId[] }>();
    for (const item of changing) {
      const change = perItem.get(item)!;
      const key = JSON.stringify([[...change.add].sort(), [...change.remove].sort()]);
      const batch = batchesByKey.get(key);
      if (batch) batch.ids.push(item);
      else batchesByKey.set(key, { ids: [item], add: change.add, remove: change.remove });
    }
    batches = [...batchesByKey.values()].map((b) => ({ ids: b.ids, change: changeOf(b.add, b.remove) }));
  }

  const plan: TaggingPlan = {
    add,
    remove,
    create,
    kind,
    refused,
    conflicts,
    batches,
    itemCount: perItem.size,
    isEmpty: perItem.size === 0,
    ok: conflicts.length === 0,
    revision: space.revision,
  };

  const compare = options.compare ?? byPath;
  const rows: TagRow[] = entries
    .map(({ row }) => {
      const conflict = conflictOf.get(row.group);
      return conflict ? { ...row, conflict } : row;
    })
    .sort(compare);

  const summary: string[] = [];
  for (const row of rows) {
    if (row.change.add) summary.push(messages.tagging.summaryAdd(row.label, row.change.add));
    if (row.change.remove) summary.push(messages.tagging.summaryRemove(row.label, row.change.remove));
  }

  return { allRows: rows, plan, summary };

  function anyRowUsesBase(list: readonly RowEntry[]): boolean {
    return list.some((e) => removalKey(e.row.group) !== '');
  }
}

/** The plan as one delta. `mint` gives the new edges' ids (default: `makeEdge`'s unique ids). */
function deltaOf(
  space: GroupSpace,
  plan: Pick<TaggingPlan, 'add' | 'remove' | 'create' | 'kind'>,
  mint?: (group: NodeId, item: NodeId) => EdgeId,
): EdgeDelta {
  const added = plan.add.flatMap(({ group, ids }) =>
    ids.map((item) => makeEdge(group, item, { kind: plan.kind, ...(mint ? { id: mint(group, item) } : {}) })),
  );
  const removed = plan.remove.flatMap(({ group, ids }) =>
    ids.flatMap((item) => membershipEdges(space, group, item).map((e) => e.id)),
  );
  const upsertNodes: Node[] = plan.create.filter((c) => c.label !== c.group).map((c) => ({ id: c.group, label: c.label }));
  return { added, removed, ...(upsertNodes.length ? { upsertNodes } : {}) };
}

/**
 * The plan as one `EdgeDelta` — for a `GroupStore` (`store.apply(delta)`) or any code that holds a
 * `GroupSpace`. Removals take out every membership edge between the group and the item.
 */
export function planToDelta(space: GroupSpace, plan: TaggingPlan): EdgeDelta {
  return deltaOf(space, plan);
}

// ── the pure API ────────────────────────────────────────────────────────────

/** The menu, computed: rows (searched), the create option, the plan and its summary. */
export function toTaggingView<P>(
  source: SpaceSource<P>,
  state: TaggingState = EMPTY_TAGGING_STATE,
  options: TaggingOptions,
): TaggingView {
  const space = resolveSpace(source) as GroupSpace;
  const messages = resolveMessages(options.messages);
  const selection = unique(options.selection);
  return viewFromCore(space, selection, computeCore(space, selection, state, options, messages), state, options, messages);
}

function viewFromCore(
  space: GroupSpace,
  selection: readonly NodeId[],
  core: Core,
  state: TaggingState,
  options: TaggingOptions,
  messages: GroupsUiMessages,
): TaggingView {
  const t = messages.tagging;
  const typed = state.query.trim();
  const needle = fold(typed);
  const rows = needle
    ? core.allRows.filter(
        (r) => fold(r.label).includes(needle) || (r.path !== undefined && fold(r.path).includes(needle)) || fold(r.group).includes(needle),
      )
    : core.allRows;

  let create: CreateOption | undefined;
  if (options.allowCreate !== false && typed) {
    const group = nodeId(options.mintGroupId ? options.mintGroupId(typed, space) : typed);
    const exists = core.allRows.some((r) => r.group === group || fold(r.label) === needle);
    if (!exists) {
      const reason =
        selection.length === 0
          ? t.createNeedsSelection
          : !space.profile.groupsMayContainItems
            ? t.createNotAllowed
            : space.nodes.has(group)
              ? t.nameTaken(typed)
              : undefined;
      create = { label: typed, group, allowed: reason === undefined, ...(reason ? { reason } : {}), text: t.createOption(typed) };
    }
  }

  const empty =
    selection.length === 0
      ? t.noSelection
      : rows.length
        ? undefined
        : typed
          ? t.noMatches(typed)
          : t.noGroups;

  const blocked =
    selection.length === 0
      ? t.noSelection
      : core.plan.isEmpty
        ? t.nothingToApply
        : !core.plan.ok
          ? sentence(core.plan.conflicts[0]!)
          : undefined;

  return {
    rows,
    allRows: core.allRows,
    query: state.query,
    selection,
    ...(blocked ? { blocked } : {}),
    ...(create ? { create } : {}),
    plan: core.plan,
    summary: core.summary,
    applyLabel: t.applyButton(core.plan.itemCount),
    canApply: selection.length > 0 && core.plan.ok && !core.plan.isEmpty,
    ...(empty ? { empty } : {}),
    messages,
  };
}

/** Click a row: stage its `next` state (or un-stage it when `next` is where it started). */
export function toggleTag(state: TaggingState, row: Pick<TagRow, 'group' | 'next' | 'originalState' | 'state'>): TaggingState {
  if (row.next === row.state) return state;
  const pending = new Map(state.pending);
  if (row.next === row.originalState) pending.delete(row.group);
  else if (row.next === 'all' || row.next === 'none') pending.set(row.group, row.next);
  return { ...state, pending };
}

/** Stage a new group, applied to the whole selection. A no-op unless the view offers it as allowed. */
export function createTag(state: TaggingState, option: CreateOption | undefined): TaggingState {
  if (!option?.allowed) return state;
  const created = state.created.some((c) => c.group === option.group)
    ? state.created
    : [...state.created, { group: option.group, label: option.label }];
  const pending = new Map(state.pending);
  pending.set(option.group, 'all');
  return { ...state, created, pending };
}

/** Set the search text. Staged changes are untouched, including those on rows the search hides. */
export function setTagQuery(state: TaggingState, query: string): TaggingState {
  return query === state.query ? state : { ...state, query };
}

/** Drop the staged change of one group, or every staged change (and created group). The query stays. */
export function resetTag(state: TaggingState, group?: NodeId | string): TaggingState {
  if (group === undefined) return { ...EMPTY_TAGGING_STATE, query: state.query };
  const id = nodeId(String(group));
  const pending = new Map(state.pending);
  pending.delete(id);
  return { ...state, pending, created: state.created.filter((c) => c.group !== id) };
}

// ── outcomes ────────────────────────────────────────────────────────────────

/** One item the write refused — the shape of `@zodal/groups-collection`'s `Failure`. */
export interface ApplyFailure {
  readonly id: string;
  readonly reason: string;
  readonly code?: string;
  readonly violations?: readonly Violation[];
}

/**
 * What the caller's write reported. `@zodal/groups-collection`'s `OperationResult` is one (so are
 * several of them, one per batch).
 */
export interface ApplyOutcome {
  readonly succeeded: readonly string[];
  readonly failed: readonly ApplyFailure[];
}

/** Several outcomes (one per `bulkTag` batch) as one. An item counts as succeeded only if no batch failed it. */
export function mergeOutcomes(outcomes: readonly ApplyOutcome[]): ApplyOutcome {
  const failed = new Map<string, ApplyFailure>();
  for (const o of outcomes) for (const f of o.failed) if (!failed.has(f.id)) failed.set(f.id, f);
  const succeeded = new Set<string>();
  for (const o of outcomes) for (const id of o.succeeded) if (!failed.has(id)) succeeded.add(id);
  return { succeeded: [...succeeded], failed: [...failed.values()] };
}

export interface DescribeOptions {
  readonly space?: GroupSpace;
  readonly labelOf?: LabelOf;
  readonly messages?: MessagesOverride;
  /** How many refusals to spell out before "and N more". Default 3 (a live region is read aloud). */
  readonly maxDetails?: number;
}

/**
 * The live-region sentence after an apply: *"Applied: tagged 12 items, 2 refused: “x”: …"*. Merges
 * the write's failures with the refusals the plan left out (`plan.refused`), so nothing refused is
 * silent. A failure is worded with this module's messages: its violations if it has some, else its
 * code (`failureReasons`); the write's raw `reason` only for a code the table does not know.
 */
export function describeOutcome(
  plan: TaggingPlan,
  outcome: ApplyOutcome | readonly ApplyOutcome[],
  options: DescribeOptions = {},
): string {
  const messages = resolveMessages(options.messages);
  const merged = Array.isArray(outcome) ? mergeOutcomes(outcome) : (outcome as ApplyOutcome);
  const explainOpts = {
    messages: messages.violations,
    ...(options.space ? { space: options.space } : {}),
    ...(options.labelOf ? { labelOf: options.labelOf } : {}),
  };
  const label = (id: string) => labelFor(id, explainOpts);

  const verb = plan.add.length && plan.remove.length ? 'updated' : plan.remove.length ? 'untagged' : 'tagged';
  const details: string[] = [];
  for (const f of merged.failed) {
    // Plain language: the model's violation, else the failure code's sentence. A provider's own
    // text (`reason`) is for logs; it is used only for a code this table does not know.
    const reason = f.violations?.length
      ? explainViolation(f.violations[0]!, explainOpts).message
      : (f.code !== undefined ? messages.tagging.failureReasons[f.code] : undefined) ?? f.reason;
    details.push(messages.tagging.refusedDetail(label(f.id), reason));
  }
  for (const r of plan.refused) details.push(messages.tagging.refusedDetail(label(r.id), r.explained.message));

  const max = options.maxDetails ?? 3;
  let text = messages.tagging.applied({ changed: new Set(merged.succeeded).size, verb });
  if (details.length) text += messages.tagging.refused(details.length, details.slice(0, max), Math.max(0, details.length - max));
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * Apply a plan to a live `Groups` handle (in-memory, all or nothing) and report it as an outcome.
 * For a collection, call `bulkTag` per batch instead; for a `GroupStore`, `apply(planToDelta(…))`.
 */
export function applyTagging<P>(groups: Groups<P>, plan: TaggingPlan): ApplyOutcome {
  const changed = [...new Set(plan.batches.flatMap((b) => b.ids))];
  if (!changed.length) return { succeeded: [], failed: [] };
  const result = groups.apply(planToDelta(groups.space, plan));
  if (result.ok) return { succeeded: changed, failed: [] };
  const reason = explainViolation(result.violations[0]!, { space: groups.space }).message;
  return { succeeded: [], failed: changed.map((id) => ({ id, reason, violations: result.violations })) };
}

// ── the session: the pure API with a cache and a subscription ───────────────

export interface TaggingSession {
  /** The current view. The same object until something changes (safe for `useSyncExternalStore`). */
  view(): TaggingView;
  readonly state: TaggingState;
  /** Click a row. */
  toggle(group: NodeId | string): TaggingView;
  setQuery(query: string): TaggingView;
  /** Stage a new group named `label` (default: the search text), if the view allows it. */
  create(label?: string): TaggingView;
  /** Un-stage one group, or everything. */
  reset(group?: NodeId | string): TaggingView;
  /**
   * The plan to write. Staged changes stay staged until `complete` — clear only after the write is
   * confirmed, so a failed write loses nothing.
   */
  apply(): TaggingPlan;
  /**
   * The write landed: clear what was staged (the query stays) and return the live-region sentence.
   * With a live source (the space re-read after the write), each staged row is checked: one that
   * did not reach its staged state — another writer got in between — stays staged and the sentence
   * says so. Refused and failed items are not counted against it.
   */
  complete(outcome?: ApplyOutcome | readonly ApplyOutcome[]): string;
  /**
   * The model or the selection changed. A different selection (as a set: order and duplicates do
   * not count) drops what was staged — staged changes were made for the items the user saw — and
   * the next view carries a `notice` saying so.
   */
  update(next: { readonly source?: SpaceSource; readonly selection?: Iterable<NodeId | string> }): TaggingView;
  subscribe(listener: () => void): () => void;
}

/** A stateful tagging menu over a space and a selection. */
export function createTaggingSession<P>(source: SpaceSource<P>, options: TaggingOptions): TaggingSession {
  let src = source as SpaceSource;
  let opts = options;
  let selection = unique(options.selection);
  let state = EMPTY_TAGGING_STATE;
  /** The plan `apply()` handed out, and the space it was computed on: `complete` checks against them. */
  let handedOut: { plan: TaggingPlan; space: GroupSpace } | null = null;
  /** Said once: set by `update`, cleared by the next change. */
  let notice: string | undefined;
  const messages = resolveMessages(options.messages);
  const listeners = new Set<() => void>();
  const rowCache: RowCache = new Map();

  let coreKey: { space: GroupSpace; pending: TaggingState['pending']; created: TaggingState['created']; selection: readonly NodeId[] } | null = null;
  let core: Core | null = null;
  let cachedView: { space: GroupSpace; state: TaggingState; core: Core; notice: string | undefined; view: TaggingView } | null = null;

  /** The expensive part (dry runs, plan): recomputed when the model, the staging or the selection changes — and then only the rows the change can affect. */
  const ensureCore = (space: GroupSpace): Core => {
    if (!core || !coreKey || coreKey.space !== space || coreKey.selection !== selection) rowCache.clear();
    if (
      !core ||
      !coreKey ||
      coreKey.space !== space ||
      coreKey.pending !== state.pending ||
      coreKey.created !== state.created ||
      coreKey.selection !== selection
    ) {
      core = computeCore(space, selection, state, opts, messages, rowCache);
      coreKey = { space, pending: state.pending, created: state.created, selection };
    }
    return core;
  };

  /** The cheap part (search, create option) on top — recomputed per keystroke. */
  const view = (): TaggingView => {
    const space = resolveSpace(src);
    const c = ensureCore(space);
    if (!cachedView || cachedView.space !== space || cachedView.state !== state || cachedView.core !== c || cachedView.notice !== notice) {
      const v = viewFromCore(space, selection, c, state, opts, messages);
      cachedView = { space, state, core: c, notice, view: notice ? { ...v, notice } : v };
    }
    return cachedView.view;
  };

  const notify = (): void => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // One bad listener must not stop the others (the zodal-dials lesson).
      }
    }
  };

  const set = (next: TaggingState, keepNotice = false): TaggingView => {
    if (next !== state) {
      state = next;
      if (!keepNotice) notice = undefined;
      notify();
    }
    return view();
  };

  /** Selected items in `group` now, in `space` (direct memberships). */
  const inGroup = (space: GroupSpace, group: NodeId, item: NodeId): boolean => membershipEdges(space, group, item).length > 0;

  return {
    view,
    get state() {
      return state;
    },
    toggle(group) {
      const id = nodeId(String(group));
      const row = view().allRows.find((r) => r.group === id);
      return row ? set(toggleTag(state, row)) : view();
    },
    setQuery: (query) => set(setTagQuery(state, query), true),
    create(label) {
      const current = view();
      if (label === undefined || label.trim() === current.query.trim()) return set(createTag(state, current.create));
      // A name other than the search text: ask the same question of that name.
      const space = resolveSpace(src);
      const probe = viewFromCore(space, selection, ensureCore(space), { ...state, query: label }, opts, messages);
      return set(createTag(state, probe.create));
    },
    reset: (group) => set(resetTag(state, group)),
    apply() {
      const space = resolveSpace(src);
      const plan = view().plan;
      handedOut = { plan, space };
      return plan;
    },
    complete(outcome) {
      const plan = handedOut?.plan ?? view().plan;
      const planSpace = handedOut?.space;
      handedOut = null;
      const merged = outcome === undefined
        ? { succeeded: plan.batches.flatMap((b) => b.ids), failed: [] }
        : Array.isArray(outcome)
          ? mergeOutcomes(outcome)
          : (outcome as ApplyOutcome);
      const after = resolveSpace(src);
      const describeOpts = {
        space: after,
        ...(opts.labelOf ? { labelOf: opts.labelOf } : {}),
        ...(opts.messages ? { messages: opts.messages } : {}),
      };
      let text = describeOutcome(plan, merged, describeOpts);

      // Check each staged row against the space re-read after the write. Only possible with a live
      // source: a snapshot that did not change says nothing about the write.
      const keep = new Set<NodeId>();
      if (planSpace && after !== planSpace) {
        const failed = new Set(merged.failed.map((f) => f.id));
        const refused = new Set(plan.refused.map((r) => `${r.group}\u0000${r.id}`));
        for (const [group, target] of state.pending) {
          const expected = selection.filter((item) => !failed.has(item) && !(target === 'all' && refused.has(`${group}\u0000${item}`)));
          const reached = expected.every((item) => inGroup(after, group, item) === (target === 'all'));
          if (!reached) keep.add(group);
        }
      }
      if (keep.size) {
        text += ` ${messages.tagging.changedElsewhere([...keep].map((g) => labelFor(g, describeOpts)))}`;
        const pending = new Map([...state.pending].filter(([g]) => keep.has(g)));
        set({ ...state, pending, created: state.created.filter((c) => keep.has(c.group)) });
      } else {
        set(resetTag(state));
      }
      return text;
    },
    update(next) {
      if (next.source) src = next.source;
      if (next.selection) {
        const fresh = unique(next.selection);
        const before = new Set(selection);
        const same = fresh.length === before.size && fresh.every((id) => before.has(id));
        if (!same) {
          selection = fresh;
          opts = { ...opts, selection: fresh };
          const dropped = state.pending.size;
          notice = dropped ? messages.tagging.stagedDropped(dropped) : undefined;
          const cleared = resetTag(state);
          return set(cleared, true);
        }
      }
      // A new source with the same state: notify so renderers redraw against the new model.
      notify();
      return view();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
