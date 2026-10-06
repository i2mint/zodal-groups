/**
 * Messages — every `Violation` as a sentence a person can act on, and the tagging menu's copy.
 *
 * The model reports *what* is wrong as structured data (`Violation`: a code, the edge, the cycle
 * path, the family and its values). This module turns that into **what to say**: a sentence naming
 * the things involved by their labels, plus a suggested fix. NN/g's guideline set is the acceptance
 * test — visible, plain, specific, constructive — and two of its rules are load-bearing here:
 *
 * - **A cycle names its route** (reconciliation D15). Under polyhierarchy a loop can close through a
 *   branch that is not on screen, so "you can't do that" is indistinguishable from a bug. The
 *   violation carries the path; the sentence renders it: *"That would create a loop: Research →
 *   Reading → Paper → Research."*
 * - **A cardinality refusal names the family** (D26): *"“Status” allows one value per item, and
 *   “Bug 12” would be in both “Todo” and “Doing”"*, with the fix *"Remove it from “Todo” first."*
 *
 * Everything is a **table of functions** keyed by code, so a host can override any entry (or all of
 * them, for another language) without forking: pass `messages` to `explainViolation`, to the
 * tagging session, or to a renderer. A function per message, rather than an ICU string, keeps the
 * table typed (a missing code is a compile error, see {@link ViolationMessages}) and lets a host
 * plug in whatever i18n library it already uses. A code this table does not know — a newer
 * groups-core — falls back to the model's own English message rather than throwing.
 */

import {
  ancestors,
  edgesInto,
  isMembershipKind,
  type GroupProfile,
  type GroupSpace,
  type NodeId,
  type Violation,
} from '@zodal/groups-core';

/** Every violation code the model can report. */
export type ViolationCode = Violation['code'];

/** A violation, explained. */
export interface ExplainedViolation {
  readonly code: ViolationCode;
  /** What is wrong, naming the things involved. */
  readonly message: string;
  /** What the person can do about it. Absent when there is nothing to do (a duplicate). */
  readonly fix?: string;
  /** The structured violation it explains, for renderers that want more. */
  readonly violation: Violation;
}

/** What a message template is given. */
export interface ViolationContext {
  readonly violation: Violation;
  /** The display label of a node: the host's `labelOf`, else the node's label, else its id. */
  readonly label: (id: NodeId | string) => string;
  /** The profile the violation was judged under, when known — for the caps it names. */
  readonly profile?: GroupProfile;
  /** The space, when known — for the groups an item is already in, a family's limit. */
  readonly space?: GroupSpace;
}

export interface ViolationText {
  readonly message: string;
  readonly fix?: string;
}

export type ViolationTemplate = (context: ViolationContext) => ViolationText;

/**
 * One template per code. A mapped type over `Violation['code']`, so a code added to groups-core
 * without a message here fails the typecheck.
 */
export type ViolationMessages = { readonly [C in ViolationCode]: ViolationTemplate };

// ── helpers shared by the English templates ─────────────────────────────────

const q = (s: string): string => `“${s}”`;

/** “a”, “a” and “b”, “a”, “b” and “c”. */
const listOf = (labels: readonly string[]): string => {
  const quoted = labels.map(q);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The groups a node is directly in (membership kinds only), as labels. */
const groupsOf = (ctx: ViolationContext, id: NodeId): string[] => {
  const space = ctx.space;
  if (!space) return [];
  return edgesInto(space, id)
    .filter((e) => isMembershipKind(space.profile, e.kind))
    .map((e) => ctx.label(e.parent));
};

const childOf = (ctx: ViolationContext): string =>
  ctx.violation.edge ? ctx.label(ctx.violation.edge.child) : ctx.label(ctx.violation.node ?? '?');
const parentOf = (ctx: ViolationContext): string =>
  ctx.violation.edge ? ctx.label(ctx.violation.edge.parent) : '?';
const profileOf = (ctx: ViolationContext): GroupProfile | undefined => ctx.profile ?? ctx.space?.profile;

/** Was the violation raised about the parent becoming a group (or a group becoming an item)? */
const aboutNode = (ctx: ViolationContext): boolean =>
  ctx.violation.node !== undefined && ctx.violation.node !== ctx.violation.edge?.child;

const RELOAD = 'Reload, then try again.';

/** The English messages. Override any entry through `messages`. */
export const VIOLATION_MESSAGES: ViolationMessages = {
  cycle: (ctx) => {
    const path = (ctx.violation.path ?? []).map(ctx.label);
    if (path.length < 2) {
      return {
        message: `${q(childOf(ctx))} can't go inside ${q(parentOf(ctx))}: that would create a loop.`,
        fix: `Choose a group that is not inside ${q(childOf(ctx))}.`,
      };
    }
    // `findCycle` returns [child, …, parent]: the parent is already inside the child. Closing the
    // route back to the child makes the loop visible.
    const [child, second] = [path[0]!, path[1]!];
    const parent = path[path.length - 1]!;
    return {
      message: `That would create a loop: ${[...path, child].join(' → ')}.`,
      fix: `${q(parent)} is already inside ${q(child)}. Choose a group outside ${q(child)}, or first take ${q(second)} out of ${q(child)}.`,
    };
  },

  maxDepth: (ctx) => {
    const max = profileOf(ctx)?.maxDepth;
    if (aboutNode(ctx)) {
      const node = ctx.label(ctx.violation.node!);
      return {
        message:
          max === 0
            ? `${q(node)} is itself in a group, so giving it members would nest groups, which this space does not allow.`
            : `Giving ${q(node)} members would make it a group nested more than ${max ?? 'the allowed number of'} levels deep.`,
        fix: `Choose a group nearer the top, or take ${q(node)} out of its groups first.`,
      };
    }
    return {
      message:
        max === 0
          ? `Groups can't be nested here, and ${q(childOf(ctx))} is a group.`
          : `Putting ${q(childOf(ctx))} inside ${q(parentOf(ctx))} would nest groups more than ${max ?? 'the allowed number of'} ${plural(max ?? 2, 'level', 'levels')} deep.`,
      fix: `Choose a group nearer the top, or flatten the groups inside ${q(childOf(ctx))}.`,
    };
  },

  maxParentsPerItem: (ctx) => {
    const cap = profileOf(ctx)?.maxParentsPerItem;
    const capText = cap == null ? 'a limited number of' : String(cap);
    if (aboutNode(ctx)) {
      const node = ctx.label(ctx.violation.node!);
      return {
        message: `${q(node)} would lose its last member and count as an item, and an item can be in only ${capText} ${plural(cap ?? 2, 'group', 'groups')} here.`,
        fix: `Keep a member in ${q(node)}, or take it out of a group first.`,
      };
    }
    const child = childOf(ctx);
    const current = ctx.violation.edge ? groupsOf(ctx, ctx.violation.edge.child) : [];
    return {
      message:
        `${q(child)} can be in only ${capText} ${plural(cap ?? 2, 'group', 'groups')} here` +
        (current.length ? `, and it is already in ${listOf(current)}.` : ', and it is already in that many.'),
      fix:
        cap === 1
          ? `Move it to ${q(parentOf(ctx))} instead, or take it out of ${current.length ? listOf(current) : 'its group'} first.`
          : `Take it out of one of its groups first, or move it instead.`,
    };
  },

  maxParentsPerGroup: (ctx) => {
    const cap = profileOf(ctx)?.maxParentsPerGroup;
    const capText = cap == null ? 'a limited number of' : String(cap);
    if (aboutNode(ctx)) {
      const node = ctx.label(ctx.violation.node!);
      const current = groupsOf(ctx, ctx.violation.node!);
      return {
        message:
          `${q(node)} is in ${current.length ? listOf(current) : 'several groups'}; giving it members would make it a group, ` +
          `and a group can be in only ${capText} ${plural(cap ?? 2, 'group', 'groups')} here.`,
        fix: `Choose another group, or take ${q(node)} out of all but ${capText} of its groups first.`,
      };
    }
    const child = childOf(ctx);
    const current = ctx.violation.edge ? groupsOf(ctx, ctx.violation.edge.child) : [];
    return {
      message:
        `${q(child)} is a group, and a group can be in only ${capText} ${plural(cap ?? 2, 'group', 'groups')} here` +
        (current.length ? `; it is already in ${listOf(current)}.` : '.'),
      fix: `Move it to ${q(parentOf(ctx))} instead, or take it out of ${current.length ? listOf(current) : 'its parent'} first.`,
    };
  },

  maxGroupsPerItem: (ctx) => {
    const max = profileOf(ctx)?.maxGroupsPerItem;
    const node = aboutNode(ctx) ? ctx.label(ctx.violation.node!) : childOf(ctx);
    const id = aboutNode(ctx) ? ctx.violation.node! : ctx.violation.edge?.child;
    const current = id ? groupsOf(ctx, id) : [];
    return {
      message: `${q(node)} already has the most groups an item may have here${max == null ? '' : ` (${max})`}.`,
      fix: current.length ? `Remove it from one of ${listOf(current)} first.` : 'Remove it from one of its groups first.',
    };
  },

  groupsMayContainGroups: (ctx) => {
    if (aboutNode(ctx)) {
      const node = ctx.label(ctx.violation.node!);
      return {
        message: `${q(node)} is itself in a group, so it can't have members here: groups can't contain groups.`,
        fix: `Choose another group, or take ${q(node)} out of its groups first.`,
      };
    }
    return {
      message: `${q(childOf(ctx))} is a group, and groups can't contain other groups here.`,
      fix: `Add the items inside ${q(childOf(ctx))} instead.`,
    };
  },

  groupsMayContainItems: (ctx) => {
    if (aboutNode(ctx) || !ctx.violation.edge) {
      const node = ctx.label(ctx.violation.node ?? '?');
      return {
        message: `${q(node)} would have no members left, so it would count as an item, and groups here contain only groups.`,
        fix: `Keep at least one member in ${q(node)}, or delete it.`,
      };
    }
    return {
      message: `Groups here contain only other groups, and ${q(childOf(ctx))} is an item.`,
      fix: `Keep items in a separate space next to this one.`,
    };
  },

  groupsAreItems: (ctx) => ({
    message: `${q(childOf(ctx))} is a group, and groups can't be members here.`,
    fix: `Add the items inside ${q(childOf(ctx))} instead.`,
  }),

  unknownEdgeKind: (ctx) => {
    const kind = ctx.violation.edge?.kind ?? '?';
    const kinds = Object.keys(profileOf(ctx)?.edgeKinds ?? {});
    return {
      message: `This space has no ${q(kind)} relation.`,
      fix: kinds.length ? `Use one of: ${kinds.join(', ')}.` : 'Use a relation this space declares.',
    };
  },

  disjointEdgeKind: (ctx) => {
    const edge = ctx.violation.edge;
    const kind = edge?.kind ?? '?';
    // Find the existing link it clashes with, either way round, to name it.
    let other: string | undefined;
    if (edge && ctx.space) {
      const p = ctx.space.profile;
      const clash = (a: string, b: string) =>
        Boolean(p.edgeKinds[a]?.disjointWith?.includes(b) || p.edgeKinds[b]?.disjointWith?.includes(a));
      const between = [
        ...edgesInto(ctx.space, edge.child).filter((e) => e.parent === edge.parent),
        ...edgesInto(ctx.space, edge.parent).filter((e) => e.parent === edge.child),
      ];
      other = between.find((e) => e.id !== edge.id && clash(kind, e.kind))?.kind;
    }
    return {
      message: `${q(childOf(ctx))} and ${q(parentOf(ctx))} are already linked${other ? ` as ${q(other)}` : ''}, which can't be combined with ${q(kind)}.`,
      fix: `Remove the existing ${other ? `${q(other)} ` : ''}link first.`,
    };
  },

  selfEdge: () => ({
    message: `A group can't contain itself.`,
    fix: `Choose a different group.`,
  }),

  duplicateEdge: (ctx) => ({
    message: `${q(childOf(ctx))} is already in ${q(parentOf(ctx))}.`,
  }),

  danglingEdge: (ctx) => ({
    message: `${q(ctx.label(ctx.violation.node ?? '?'))} still has memberships, so it can't be deleted on its own.`,
    fix: `Delete it together with its memberships.`,
  }),

  maxPerFamily: (ctx) => {
    const v = ctx.violation;
    const family = ctx.label(v.family ?? '?');
    const item = ctx.label(v.node ?? v.edge?.child ?? '?');
    const values = v.values ?? [];
    const max = v.family ? ctx.space?.nodes.get(v.family)?.family?.maxPerItem : undefined;
    // The values the item is already in: every value except the one the new membership reaches.
    const adding = v.edge?.parent;
    const reached = new Set<NodeId>(adding ? [adding] : []);
    if (adding && ctx.space) for (const a of ancestors(ctx.space, adding)) reached.add(a);
    const others = values.filter((x) => !reached.has(x)).map(ctx.label);
    const labels = values.map(ctx.label);
    return {
      message:
        max === 1
          ? `${q(family)} allows one value per item, and ${q(item)} would be in ${labels.length === 2 ? 'both ' : ''}${listOf(labels)}.`
          : `${q(family)} allows ${max ?? 'a limited number of'} ${plural(max ?? 2, 'value', 'values')} per item, and ${q(item)} would be in ${values.length}: ${listOf(labels)}.`,
      fix: others.length
        ? `Remove ${q(item)} from ${listOf(others)} first.`
        : `Remove ${q(item)} from another value of ${q(family)} first.`,
    };
  },

  invalidFamilyRule: (ctx) => ({
    message: `The value limit on ${q(ctx.label(ctx.violation.node ?? '?'))} must be a whole number of at least 1.`,
    fix: `Set it to 1 (one value per item) or more.`,
  }),

  malformed: (ctx) => {
    const what = ctx.violation.node ?? ctx.violation.edge?.id;
    return {
      message: `${what ? q(ctx.label(what)) : 'This change'} can't be saved: its data is not valid.`,
      fix: `Use plain JSON values (no dates, functions, BigInts or NaN) in its payload and metadata.`,
    };
  },

  staleTombstone: (ctx) => ({
    message: `${q(ctx.label(ctx.violation.node ?? '?'))} changed since this action, so undoing it would lose that change.`,
    fix: RELOAD,
  }),

  nodeExists: (ctx) => ({
    message: `${q(ctx.label(ctx.violation.node ?? '?'))} already exists: it was created again since this action.`,
    fix: RELOAD,
  }),

  edgeIdExists: (ctx) => ({
    message: `The membership of ${q(childOf(ctx))} in ${q(parentOf(ctx))} changed since this action.`,
    fix: RELOAD,
  }),

  conflict: (ctx) => {
    const { expectedRevision: expected, actualRevision: actual } = ctx.violation;
    return {
      message:
        `These groups were changed elsewhere since you loaded them` +
        (expected !== undefined && actual !== undefined ? ` (you had version ${expected}; it is now ${actual}).` : '.'),
      fix: `Reload and apply your change again.`,
    };
  },
};
Object.freeze(VIOLATION_MESSAGES);

/** Every code the default table covers — all of `Violation['code']` (the mapped type enforces it). */
export const VIOLATION_CODES: readonly ViolationCode[] = Object.freeze(Object.keys(VIOLATION_MESSAGES) as ViolationCode[]);

// ── the tagging menu's copy ─────────────────────────────────────────────────

/** Everything the tagging menu says that is not a violation. Override any entry through `messages`. */
export interface TaggingMessages {
  /** Accessible name of the search field. */
  readonly searchLabel: string;
  readonly searchPlaceholder: (canCreate: boolean) => string;
  /** Accessible name of the list of groups. */
  readonly listLabel: (selected: number) => string;
  /** A row's "7 of 12". */
  readonly countOf: (count: number, total: number) => string;
  /**
   * A row's accessible name: label (or path), how many of the selection are in it now, and what
   * Apply would do. The state is in words because `aria-checked="mixed"` is defined for checkboxes,
   * not for listbox options, so a renderer drawing options cannot rely on it.
   */
  readonly rowLabel: (row: {
    readonly label: string;
    readonly path?: string;
    readonly count: number;
    readonly total: number;
    readonly isNew: boolean;
    readonly pending: boolean;
    readonly change: { readonly add: number; readonly remove: number };
  }) => string;
  readonly createOption: (label: string) => string;
  readonly createNotAllowed: string;
  readonly createNeedsSelection: string;
  readonly nameTaken: (label: string) => string;
  readonly noMatches: (query: string) => string;
  readonly noGroups: string;
  readonly noSelection: string;
  /** A line of the staged-changes summary. */
  readonly summaryAdd: (label: string, items: number) => string;
  readonly summaryRemove: (label: string, items: number) => string;
  /** Some of the selection would be refused if the group were applied to all of it. */
  readonly partlyRefused: (refused: number, of: number, reason: string) => string;
  readonly applyButton: (items: number) => string;
  readonly applying: string;
  readonly cancelButton: string;
  /** The live-region sentence after an apply: "Applied: tagged 12 items". */
  readonly applied: (outcome: { readonly changed: number; readonly verb: 'tagged' | 'untagged' | 'updated' }) => string;
  /** Appended when some were refused: ", 2 refused: …". `details` is already capped. */
  readonly refused: (count: number, details: readonly string[], more: number) => string;
  readonly refusedDetail: (item: string, reason: string) => string;
  /**
   * The write threw. Plain language only: the error itself (a path, an errno) is for the host's
   * logs — the vanilla menu hands it to `onError` — never for a live region.
   */
  readonly applyFailed: string;
  /** Create refused: the backing stores group ids only, and the id minted from the name differs. */
  readonly labelNotStored: (label: string, id: string) => string;
  /** Why Apply does nothing right now. */
  readonly nothingToApply: string;
  readonly stillApplying: string;
  /** A staged row the write did not bring to its staged state (another writer got there first). */
  readonly changedElsewhere: (labels: readonly string[]) => string;
  /** The selection changed under staged changes, which were dropped. */
  readonly stagedDropped: (count: number) => string;
  /** Escape or Cancel discarded staged changes. */
  readonly discarded: (count: number) => string;
  /**
   * A write failure, by its code (groups-collection's `FailureCode`), in plain language — the
   * provider's own text (`Failure.reason`) is for logs, not for a live region. A code missing here
   * falls back to that text.
   */
  readonly failureReasons: Readonly<Record<string, string>>;
}

const items = (n: number) => `${n} ${plural(n, 'item', 'items')}`;

export const TAGGING_MESSAGES: TaggingMessages = {
  searchLabel: 'Search groups',
  searchPlaceholder: (canCreate) => (canCreate ? 'Search or create a group…' : 'Search groups…'),
  listLabel: (selected) => `Groups for ${selected} selected ${plural(selected, 'item', 'items')}`,
  countOf: (count, total) => `${count} of ${total}`,
  rowLabel: (row) => {
    const now = row.isNew
      ? 'new group'
      : row.count === 0
        ? 'on none'
        : row.count >= row.total
          ? `on all ${row.total}`
          : `on ${row.count} of ${row.total}`;
    const staged = row.pending
      ? [row.change.add ? `will add to ${row.change.add}` : '', row.change.remove ? `will remove from ${row.change.remove}` : '']
      : [];
    return [row.path ?? row.label, now, ...staged].filter(Boolean).join(', ');
  },
  createOption: (label) => `Create ${q(label)}`,
  createNotAllowed: 'New groups can’t be created here.',
  createNeedsSelection: 'Select items first, then create a group for them.',
  nameTaken: (label) => `${q(label)} is already the name of something that is not a group here.`,
  noMatches: (query) => `No group matches ${q(query)}.`,
  noGroups: 'No groups yet.',
  noSelection: 'Select items to tag them.',
  summaryAdd: (label, n) => `Add ${q(label)} to ${items(n)}`,
  summaryRemove: (label, n) => `Remove ${q(label)} from ${items(n)}`,
  partlyRefused: (refused, of, reason) => `${refused} of ${of} can’t take it: ${reason}`,
  applyButton: (n) => (n === 0 ? 'Apply' : `Apply to ${items(n)}`),
  applying: 'Applying…',
  cancelButton: 'Cancel',
  applied: ({ changed, verb }) => `Applied: ${verb} ${items(changed)}`,
  refused: (count, details, more) =>
    `, ${count} refused: ${details.join('; ')}${more > 0 ? `; and ${more} more` : ''}`,
  refusedDetail: (item, reason) => `${q(item)}: ${reason}`,
  applyFailed: 'Could not apply: the change could not be saved. Your changes are still staged.',
  labelNotStored: (label, id) =>
    `Groups here are stored by name, so ${q(label)} would be saved as ${q(id)}. Type ${q(id)} to create it.`,
  nothingToApply: 'Nothing to apply yet: tick or untick a group first.',
  stillApplying: 'Still applying, please wait.',
  changedElsewhere: (labels) => {
    const one = labels.length === 1;
    return `${listOf(labels)} ${one ? 'was' : 'were'} changed elsewhere and ${one ? 'is' : 'are'} not as staged yet; review ${one ? 'it' : 'them'} and apply again.`;
  },
  stagedDropped: (n) => `The selection changed, so ${n} staged ${plural(n, 'change was', 'changes were')} discarded.`,
  discarded: (n) => `Discarded ${n} staged ${plural(n, 'change', 'changes')}.`,
  failureReasons: Object.freeze({
    notFound: 'it no longer exists',
    exists: 'it already exists',
    recordWrite: 'its record could not be saved',
    storeWrite: 'its groups could not be saved',
    conflict: 'it was changed elsewhere at the same time',
    unsupported: 'this space can’t do that',
    groupExists: 'a group with that name already exists',
    violation: 'the groups’ rules refuse it',
  }),
};
Object.freeze(TAGGING_MESSAGES);

// ── the whole table, and overriding it ──────────────────────────────────────

export interface GroupsUiMessages {
  readonly violations: ViolationMessages;
  readonly tagging: TaggingMessages;
}

/** What a host passes to override some messages — any subset of either table. */
export interface MessagesOverride {
  readonly violations?: Partial<ViolationMessages>;
  readonly tagging?: TaggingMessagesOverride;
}

export const DEFAULT_MESSAGES: GroupsUiMessages = Object.freeze({
  violations: VIOLATION_MESSAGES,
  tagging: TAGGING_MESSAGES,
});

/** A plain object (a nested table such as `failureReasons`), not a function or a string. */
const isTable = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;

/** `base` with `over` on top, nested tables merged entry by entry (overriding one failure reason keeps the others). */
function mergeTable<T extends object>(base: T, over: Partial<T> | undefined): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(over ?? {})) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isTable(current) && isTable(value) ? mergeTable(current, value) : value;
  }
  return out as T;
}

/**
 * What a host passes for the tagging table: any entry, and any part of a nested table.
 */
export type TaggingMessagesOverride = { readonly [K in keyof TaggingMessages]?: TaggingMessages[K] extends Readonly<Record<string, string>> ? Partial<TaggingMessages[K]> : TaggingMessages[K] };

/** The default tables with the host's overrides on top — merged deeply, so a nested table keeps the entries not overridden. */
export function resolveMessages(override: MessagesOverride = {}): GroupsUiMessages {
  return {
    violations: mergeTable(VIOLATION_MESSAGES, override.violations),
    tagging: mergeTable(TAGGING_MESSAGES, override.tagging as Partial<TaggingMessages> | undefined),
  };
}

// ── explaining ──────────────────────────────────────────────────────────────

/** How a host labels a node (an item's title, say). Return `undefined` to fall back to the node label. */
export type LabelOf = (id: NodeId, space?: GroupSpace) => string | undefined;

export interface ExplainOptions {
  /** The space the violation came from: lets the message name labels, current groups, family limits. */
  readonly space?: GroupSpace;
  /** The profile, when there is no space at hand. */
  readonly profile?: GroupProfile;
  readonly labelOf?: LabelOf;
  readonly messages?: Partial<ViolationMessages>;
}

/** The label a message uses for a node: the host's, else the node's own, else its id. */
export function labelFor(id: NodeId | string, options: { readonly space?: GroupSpace; readonly labelOf?: LabelOf } = {}): string {
  const nid = id as NodeId;
  return options.labelOf?.(nid, options.space) ?? options.space?.nodes.get(nid)?.label ?? String(id);
}

/** One violation as a sentence plus a suggested fix. Never throws: an unknown code keeps the model's message. */
export function explainViolation(violation: Violation, options: ExplainOptions = {}): ExplainedViolation {
  const template = options.messages?.[violation.code] ?? VIOLATION_MESSAGES[violation.code];
  if (!template) return { code: violation.code, message: violation.message, violation };
  const profile = options.profile ?? options.space?.profile;
  const text = template({
    violation,
    label: (id) => labelFor(id, options),
    ...(profile ? { profile } : {}),
    ...(options.space ? { space: options.space } : {}),
  });
  return { code: violation.code, message: text.message, ...(text.fix ? { fix: text.fix } : {}), violation };
}

/** Several violations, explained; identical sentences are reported once. */
export function explainViolations(violations: readonly Violation[], options: ExplainOptions = {}): ExplainedViolation[] {
  const seen = new Set<string>();
  const out: ExplainedViolation[] = [];
  for (const v of violations) {
    const e = explainViolation(v, options);
    const key = `${e.message}\u0000${e.fix ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** "message fix" — the one-line form a tooltip or a live region uses. */
export const sentence = (e: Pick<ExplainedViolation, 'message' | 'fix'>): string => (e.fix ? `${e.message} ${e.fix}` : e.message);
