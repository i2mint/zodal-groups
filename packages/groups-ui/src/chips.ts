/**
 * Group chips — the phone-sized way to browse nested groups: a drill-down row of chips.
 *
 * The first row is `All · <root groups, with counts> · Ungrouped`. Choosing a group that has
 * subgroups adds a second row, `All of <group> · <its subgroups>`, and so on down. The whole view
 * state is **one path** (root-first group ids), exactly like Miller columns, because it is the same
 * idea folded into rows: *a chip stack is a path*, so "which of this group's parents am I under?"
 * is answered by the row above. It is the touch counterpart of a facet sidebar, and a host can put
 * the path in its URL.
 *
 * Counts come from `facetPanel` (a de-duplicated union over the closure, never a sum of children),
 * counted over the host's item pool. "Ungrouped" is everything the root chips do not reach (All
 * minus the union of every root's closure, by the same membership rules the counts use), so All is
 * always the groups plus Ungrouped: Zotero's "Unfiled Items", and the chip that replaces a separate
 * "not in a group" section.
 *
 * Pure: a function of `(groups, options)`. The host (or a renderer) memoizes on `groups.revision`.
 */

import {
  allItems,
  edgesInto,
  edgesOf,
  isGroup,
  matchingItems,
  type GroupSpace,
  type Groups,
  type NodeId,
} from '@zodal/groups-core';

/** Where the user is: a root-first route of groups, or the "Ungrouped" chip. */
export interface GroupChipsSelection {
  /** Root-first group ids; empty means "All". */
  readonly path: readonly NodeId[];
  /** The "Ungrouped" chip (items in no group). `path` is empty when this is true. */
  readonly ungrouped: boolean;
}

/** "All": no group chosen. */
export const ALL_GROUPS: GroupChipsSelection = Object.freeze({ path: Object.freeze([]), ungrouped: false });

export type GroupChipKind = 'all' | 'group' | 'ungrouped';

/** One chip, ready to render as a toggle button. */
export interface GroupChip {
  /** Unique within its row: `'all'`, `'ungrouped'`, or `'group:' + nodeId`. */
  readonly key: string;
  readonly kind: GroupChipKind;
  /** The group, for `kind: 'group'`. */
  readonly nodeId?: NodeId;
  readonly label: string;
  /** Items in this chip's scope (closure, de-duplicated), counted over the pool. */
  readonly count: number;
  readonly pressed: boolean;
  /** On the chosen path above the pressed chip (the chip that opened the next row). */
  readonly onPath: boolean;
  /** A group with subgroups: choosing it opens another row. */
  readonly hasChildren: boolean;
  /** What choosing this chip navigates to. */
  readonly target: GroupChipsSelection;
  readonly aria: { readonly label: string; readonly pressed: boolean };
}

/** One row of chips: the roots, or the subgroups of `parent`. */
export interface GroupChipRow {
  /** 0 for the roots; `k` for the subgroups of `selection.path[k - 1]`. */
  readonly depth: number;
  readonly parent?: NodeId;
  /** The row's accessible name ("Groups", "In Campfire"). */
  readonly label: string;
  readonly chips: readonly GroupChip[];
}

export interface GroupChipsView {
  /** The selection actually shown: the requested one, with any invalid tail dropped. */
  readonly selection: GroupChipsSelection;
  readonly rows: readonly GroupChipRow[];
}

/** The words a chip row uses. Override any of them (translation, house style). */
export interface GroupChipsLabels {
  readonly all: string;
  readonly allOf: (group: string) => string;
  readonly ungrouped: string;
  readonly rootRow: string;
  readonly subRow: (group: string) => string;
  /** The count as spoken, appended to the chip's accessible name. */
  readonly count: (n: number) => string;
}

export const GROUP_CHIPS_LABELS: GroupChipsLabels = {
  all: 'All',
  allOf: (group) => `All of ${group}`,
  ungrouped: 'Ungrouped',
  rootRow: 'Groups',
  subRow: (group) => `In ${group}`,
  count: (n) => `${n} item${n === 1 ? '' : 's'}`,
};

export interface GroupChipsOptions {
  /** The current selection. Default: All. */
  readonly selection?: Partial<GroupChipsSelection>;
  /**
   * The items to count (and filter) over, e.g. every song the host has, grouped or not. Ids not in
   * the space count as ungrouped. Default: every non-group node in the space.
   */
  readonly items?: Iterable<NodeId>;
  /**
   * What the first row's All chip stands for, when that is not the whole pool: a host whose home
   * view is "recently viewed" or "starred" passes those ids, and relabels the chip
   * (`labels.all`). The chip's count follows them, and so does `groupChipItems` for All. The group
   * chips and Ungrouped still count over `items`, so a group shows every member it has, not only
   * the ones in this set. Default: the pool (All is the groups plus Ungrouped).
   */
  readonly allChipItems?: Iterable<NodeId>;
  /** Offer the "Ungrouped" chip. Default `true`. */
  readonly ungrouped?: boolean;
  /** Hide chips that would lead to zero items (the chosen one always stays). Default `true`. */
  readonly hideEmpty?: boolean;
  /** Chip order within a row: by label (stable as counts change, the default) or by count. */
  readonly sort?: 'label' | 'count';
  readonly labels?: Partial<GroupChipsLabels>;
}

/** The subgroups of `group`: children through a transitive kind that are groups themselves. */
const subgroupsOf = <P>(space: GroupSpace<P>, group: NodeId): NodeId[] => [
  ...new Set(
    edgesOf(space, group)
      .filter((e) => e.child !== group && space.profile.edgeKinds[e.kind]?.transitive)
      .map((e) => e.child)
      .filter((id) => isGroup(space, id)),
  ),
];

/** The groups a row offers: the subgroups of `under`, or the roots. The same sets `facetPanel` offers. */
const candidates = <P>(groups: Groups<P>, under?: NodeId): NodeId[] =>
  under
    ? subgroupsOf(groups.space, under)
    : [...groups.space.nodes.keys()].filter((id) => isGroup(groups.space, id) && !edgesInto(groups.space, id).length);

/**
 * Normalize a requested selection: keep the longest valid prefix of `path`, where each step is a
 * subgroup of the previous one and the first is a root. A lone non-root group (a URL like
 * `?group=slow-ones`) is expanded to its primary path, so a deep link to a subgroup still works.
 */
export function normalizeChipSelection<P>(
  groups: Groups<P>,
  selection: Partial<GroupChipsSelection> = {},
): GroupChipsSelection {
  const requested = selection.path ?? [];
  if (selection.ungrouped && !requested.length) return { path: [], ungrouped: true };
  if (!requested.length) return ALL_GROUPS;

  let route: readonly NodeId[] = requested;
  const first = requested[0]!;
  if (isGroup(groups.space, first) && !candidates(groups).includes(first)) {
    const primary = groups.path(first)?.path;
    if (primary) route = [...primary, ...requested.slice(1)];
  }

  const path: NodeId[] = [];
  for (const id of route) {
    if (!isGroup(groups.space, id)) break;
    if (!candidates(groups, path[path.length - 1]).includes(id)) break;
    if (path.includes(id)) break; // cycle-safe on read
    path.push(id);
  }
  return path.length ? { path, ungrouped: false } : ALL_GROUPS;
}

/** The pool items no root group reaches: All minus the union of the roots' closures. */
const ungroupedItems = <P>(groups: Groups<P>, pool: readonly NodeId[]): NodeId[] => {
  const grouped = matchingItems(groups.space, candidates(groups), pool);
  return pool.filter((id) => !grouped.has(id));
};

/** Same selection? (Paths compared by value.) */
export function sameChipSelection(a: GroupChipsSelection, b: GroupChipsSelection): boolean {
  return a.ungrouped === b.ungrouped && a.path.length === b.path.length && a.path.every((id, i) => b.path[i] === id);
}

/**
 * The chip rows for a selection.
 *
 * @example
 * const view = toGroupChips(groups, { selection: { path: [campfire] }, items: allSongIds });
 * // view.rows[0].chips → All 17 · Campfire 6 · Taylor Swift 5 · To learn 3 · Ungrouped 4
 * // view.rows[1].chips → All of Campfire 6 · Slow ones 2
 */
export function toGroupChips<P>(groups: Groups<P>, options: GroupChipsOptions = {}): GroupChipsView {
  const { ungrouped: offerUngrouped = true, hideEmpty = true, sort = 'label' } = options;
  const labels = { ...GROUP_CHIPS_LABELS, ...options.labels };
  const selection = normalizeChipSelection(groups, options.selection);
  const pool = [...(options.items ?? allItems(groups.space))];
  const allCount = options.allChipItems ? new Set(options.allChipItems).size : pool.length;
  const { path } = selection;

  const name = (label: string, count: number) => `${label}, ${labels.count(count)}`;
  const labelOf = (id: NodeId) => groups.space.nodes.get(id)?.label ?? id;

  const groupRow = (depth: number): { chips: GroupChip[]; counts: Map<NodeId, number> } => {
    const under = depth ? path[depth - 1] : undefined;
    const chosen = path[depth];
    const facets = groups.facets({
      items: pool,
      hideEmpty,
      ...(under ? { under } : {}),
      ...(chosen ? { selected: new Set([chosen]) } : {}),
    });
    if (sort === 'label') facets.sort((a, b) => a.label.localeCompare(b.label));
    const counts = new Map(facets.map((f) => [f.group, f.count]));
    const chips = facets.map((f): GroupChip => {
      const pressed = f.group === chosen && path.length === depth + 1;
      const onPath = f.group === chosen && !pressed;
      return {
        key: `group:${f.group}`,
        kind: 'group',
        nodeId: f.group,
        label: f.label,
        count: f.count,
        pressed,
        onPath,
        // Not `f.hasChildren`, which is true for any group with members: a chip opens a row only
        // when there are subgroups to show in it.
        hasChildren: subgroupsOf(groups.space, f.group).length > 0,
        target: { path: [...path.slice(0, depth), f.group], ungrouped: false },
        aria: { label: name(f.label, f.count), pressed },
      };
    });
    return { chips, counts };
  };

  const rows: GroupChipRow[] = [];

  // Row 0: All · roots · Ungrouped.
  const root = groupRow(0);
  const allPressed = !path.length && !selection.ungrouped;
  const first: GroupChip[] = [
    {
      key: 'all',
      kind: 'all',
      label: labels.all,
      count: allCount,
      pressed: allPressed,
      onPath: false,
      hasChildren: false,
      target: ALL_GROUPS,
      aria: { label: name(labels.all, allCount), pressed: allPressed },
    },
    ...root.chips,
  ];
  if (offerUngrouped) {
    const count = ungroupedItems(groups, pool).length;
    if (count || !hideEmpty || selection.ungrouped) {
      first.push({
        key: 'ungrouped',
        kind: 'ungrouped',
        label: labels.ungrouped,
        count,
        pressed: selection.ungrouped,
        onPath: false,
        hasChildren: false,
        target: { path: [], ungrouped: true },
        aria: { label: name(labels.ungrouped, count), pressed: selection.ungrouped },
      });
    }
  }
  rows.push({ depth: 0, label: labels.rootRow, chips: first });

  // One more row per chosen group that has subgroups.
  let counts = root.counts;
  for (let depth = 1; depth <= path.length; depth++) {
    const parent = path[depth - 1]!;
    const next = groupRow(depth);
    if (!next.chips.length && depth === path.length) break; // a leaf group (or all subgroups empty): no row
    const parentLabel = labelOf(parent);
    const parentCount = counts.get(parent) ?? 0;
    const pressed = path.length === depth;
    rows.push({
      depth,
      parent,
      label: labels.subRow(parentLabel),
      chips: [
        {
          key: 'all',
          kind: 'all',
          nodeId: parent,
          label: labels.allOf(parentLabel),
          count: parentCount,
          pressed,
          onPath: false,
          hasChildren: false,
          target: { path: path.slice(0, depth), ungrouped: false },
          aria: { label: name(labels.allOf(parentLabel), parentCount), pressed },
        },
        ...next.chips,
      ],
    });
    counts = next.counts;
  }

  return { selection, rows };
}

/**
 * The items a selection matches, in pool order: everything for All (or `allChipItems`, in their
 * own order, when the All chip stands for another set), the items in no group for Ungrouped,
 * otherwise the items in the chosen group *or any subgroup* (the closure).
 */
export function groupChipItems<P>(
  groups: Groups<P>,
  selection: GroupChipsSelection,
  items: Iterable<NodeId> = allItems(groups.space),
  options: { readonly allChipItems?: Iterable<NodeId> } = {},
): NodeId[] {
  const pool = [...items];
  if (selection.ungrouped) return ungroupedItems(groups, pool);
  const group = selection.path[selection.path.length - 1];
  if (!group) return options.allChipItems ? [...new Set(options.allChipItems)] : pool;
  return [...matchingItems(groups.space, [group], pool)];
}
