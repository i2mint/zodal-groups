/**
 * A multi-family facet sidebar, headless: one entry per family (a group whose children are the
 * values: `Genre` → Rock, Jazz), an "any of" panel per family, and the applied filters as chips.
 *
 * The filter is the classic faceted one, and the counts follow from it:
 *
 * - **within a family, OR**: `Genre: Rock or Jazz` matches an item in Rock *or* Jazz (each value
 *   with its closure: an item in `Rock/Indie` is in Rock);
 * - **between families, AND**: `Genre: Rock` and `Mood: Calm` matches items in both;
 * - **a family's counts ignore its own selection** (the N+1 rule): each value's count is the items
 *   it would match given every *other* family's selection, so ticking Rock never zeroes Jazz. The
 *   counts come from `facetPanel` (de-duplicated over the closure, never a sum of children), one
 *   call per family over the pool the other families leave.
 *
 * The view state is the host's: a set of selected value ids (across families) and which family's
 * panel is open. `toggleFacetValue` and `clearFacetFamily` compute the next selection; a renderer
 * (groups-ui-vanilla `renderFacetSidebar`, or a React one) draws the view and hands the new set
 * back. Pure: a function of `(groups, options)`; memoize on `groups.revision` and the options.
 *
 * @see issue #15; the `faceted-filter-ux` guidance (one button per family, inline panel, chips).
 */

import {
  allItems,
  edgesOf,
  facetPanel,
  isGroup,
  matchingItems,
  nodeId,
  type FacetValue,
  type Groups,
  type NodeId,
} from '@zodal/groups-core';

/** The words the sidebar uses. Override any of them (translation, house style). */
export interface FacetSidebarLabels {
  /** The panel's accessible name: "Any of Genre". */
  readonly anyOf: (family: string) => string;
  /** Between two values of one family in the applied chips: "or". */
  readonly or: string;
  /** Between two families in the applied chips: "and". */
  readonly and: string;
  /** The family's clear button. */
  readonly clear: string;
  /** Clears every family. */
  readonly clearAll: string;
  /** The applied filters' accessible name. */
  readonly applied: string;
  /** A chip's remove button: "Remove Rock from Genre". */
  readonly remove: (value: string, family: string) => string;
  /** The count as spoken, appended to a value's accessible name. */
  readonly count: (n: number) => string;
  /** The family button's accessible name: "Genre, 2 selected". */
  readonly family: (family: string, selected: number) => string;
}

export const FACET_SIDEBAR_LABELS: FacetSidebarLabels = {
  anyOf: (family) => `Any of ${family}`,
  or: 'or',
  and: 'and',
  clear: 'Clear',
  clearAll: 'Clear all',
  applied: 'Applied filters',
  remove: (value, family) => `Remove ${value} from ${family}`,
  count: (n) => `${n} item${n === 1 ? '' : 's'}`,
  family: (family, selected) => (selected ? `${family}, ${selected} selected` : family),
};

export interface FacetSidebarOptions {
  /** The families, in display order: groups whose children are the values. */
  readonly families: Iterable<NodeId | string>;
  /** The selected values, across families. Ids that are no listed family's value are dropped. */
  readonly selected?: Iterable<NodeId | string>;
  /** The items to count and filter over. Default: every non-group node in the space. */
  readonly items?: Iterable<NodeId>;
  /** The family whose panel is open, or none. A family that is not listed counts as none. */
  readonly open?: NodeId | string | null;
  /** Hide values that would lead to zero items (a selected one always stays). Default `true`. */
  readonly hideEmpty?: boolean;
  /** Value order in a panel: by count (facetPanel's, the default) or by label (stable as counts change). */
  readonly sort?: 'count' | 'label';
  readonly labels?: Partial<FacetSidebarLabels>;
}

/** One value in a family's panel: a checkbox. */
export interface FacetSidebarValue extends FacetValue {
  /** Unique within the sidebar: `family + '/' + group`. */
  readonly key: string;
  readonly family: NodeId;
  readonly aria: { readonly label: string; readonly checked: boolean };
}

/** One family: its button and its panel. */
export interface FacetSidebarFamily {
  readonly family: NodeId;
  readonly key: string;
  readonly label: string;
  readonly open: boolean;
  /** How many of its values are selected. */
  readonly selectedCount: number;
  readonly values: readonly FacetSidebarValue[];
  readonly aria: { readonly label: string; readonly expanded: boolean; readonly panelLabel: string };
}

/** One family's applied filter: `Genre: Rock or Jazz`. */
export interface AppliedFacet {
  readonly family: NodeId;
  readonly label: string;
  readonly values: readonly { readonly group: NodeId; readonly label: string; readonly removeLabel: string }[];
  /** "Genre: Rock or Jazz". */
  readonly text: string;
}

export interface FacetSidebarView {
  readonly families: readonly FacetSidebarFamily[];
  /** The families with a selection, in family order. Joined by `labels.and`. */
  readonly applied: readonly AppliedFacet[];
  /** The selection actually applied (normalized). */
  readonly selected: ReadonlySet<NodeId>;
  readonly open: NodeId | null;
  /** The items the whole selection matches, in pool order (the pool when nothing is selected). */
  readonly matching: readonly NodeId[];
  /** The applied filters as one sentence: "Genre: Rock or Jazz and Mood: Calm" (empty when none). */
  readonly summary: string;
  readonly labels: FacetSidebarLabels;
}

/** The values of a family: its group children (by a transitive edge), in no particular order. */
export function facetFamilyValues<P>(groups: Groups<P>, family: NodeId | string): NodeId[] {
  const space = groups.space;
  const id = nodeId(String(family));
  const out = new Set<NodeId>();
  for (const e of edgesOf(space, id)) {
    if (e.child !== id && space.profile.edgeKinds[e.kind]?.transitive && isGroup(space, e.child)) out.add(e.child);
  }
  return [...out];
}

/** Select a value, or unselect it. Returns a new set. */
export function toggleFacetValue(selected: Iterable<NodeId | string>, value: NodeId | string): Set<NodeId> {
  const next = new Set<NodeId>([...selected].map((s) => nodeId(String(s))));
  const id = nodeId(String(value));
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Unselect every value of one family. Returns a new set. */
export function clearFacetFamily<P>(groups: Groups<P>, selected: Iterable<NodeId | string>, family: NodeId | string): Set<NodeId> {
  const values = new Set(facetFamilyValues(groups, family));
  return new Set([...selected].map((s) => nodeId(String(s))).filter((s) => !values.has(s)));
}

/** The sidebar's view: families with counts, the applied chips, and the matching items. */
export function toFacetSidebar<P>(groups: Groups<P>, options: FacetSidebarOptions): FacetSidebarView {
  const { hideEmpty = true, sort = 'count' } = options;
  const labels = { ...FACET_SIDEBAR_LABELS, ...options.labels };
  const space = groups.space;
  const labelOf = (id: NodeId) => space.nodes.get(id)?.label ?? id;

  // Families that exist, once each, in the host's order.
  const families = [...new Set([...options.families].map((f) => nodeId(String(f))))].filter((f) => space.nodes.has(f));
  const valuesOf = new Map(families.map((f) => [f, new Set(facetFamilyValues(groups, f))]));

  const requested = new Set([...(options.selected ?? [])].map((s) => nodeId(String(s))));
  const selectedIn = new Map(families.map((f) => [f, new Set([...requested].filter((s) => valuesOf.get(f)!.has(s)))]));
  const selected = new Set<NodeId>();
  for (const set of selectedIn.values()) for (const s of set) selected.add(s);

  const openRaw = options.open == null ? null : nodeId(String(options.open));
  const open = openRaw && valuesOf.has(openRaw) ? openRaw : null;

  const pool = [...(options.items ?? allItems(space))];
  // Each family's own match (OR over its selected values, with their closures), once.
  const matchOf = new Map<NodeId, Set<NodeId>>();
  for (const f of families) {
    const sel = selectedIn.get(f)!;
    if (sel.size) matchOf.set(f, matchingItems(space, sel, pool));
  }
  const passes = (item: NodeId, except?: NodeId): boolean => {
    for (const [f, match] of matchOf) if (f !== except && !match.has(item)) return false;
    return true;
  };

  const familyViews = families.map((f): FacetSidebarFamily => {
    const label = labelOf(f);
    const sel = selectedIn.get(f)!;
    const facetPool = pool.filter((item) => passes(item, f));
    const values = facetPanel(space, { under: f, items: facetPool, selected: sel, hideEmpty });
    if (sort === 'label') values.sort((a, b) => a.label.localeCompare(b.label));
    return {
      family: f,
      key: f,
      label,
      open: open === f,
      selectedCount: sel.size,
      values: values.map((v) => ({
        ...v,
        key: `${f}/${v.group}`,
        family: f,
        aria: { label: `${v.label}, ${labels.count(v.count)}`, checked: v.selected },
      })),
      aria: { label: labels.family(label, sel.size), expanded: open === f, panelLabel: labels.anyOf(label) },
    };
  });

  const applied = families
    .filter((f) => selectedIn.get(f)!.size)
    .map((f): AppliedFacet => {
      const label = labelOf(f);
      const values = [...selectedIn.get(f)!]
        .map((g) => ({ group: g, label: labelOf(g), removeLabel: labels.remove(labelOf(g), label) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return { family: f, label, values, text: `${label}: ${values.map((v) => v.label).join(` ${labels.or} `)}` };
    });

  return {
    families: familyViews,
    applied,
    selected,
    open,
    matching: matchOf.size ? pool.filter((item) => passes(item)) : pool,
    summary: applied.map((a) => a.text).join(` ${labels.and} `),
    labels,
  };
}
