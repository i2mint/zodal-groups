/**
 * A vanilla chip row for browsing nested groups — the phone counterpart of a facet sidebar.
 *
 * `All · Campfire 6 · Taylor Swift 5 · To learn 3 · Ungrouped 4`; choose Campfire, which has
 * subgroups, and a second row appears: `All of Campfire 6 · Slow ones 2`. Each chip is a toggle
 * button (`aria-pressed`), each row a labelled group, and every chip is a thumb-sized target on a
 * coarse pointer (styles.css). The rows and counts come from `toGroupChips` in `@zodal/groups-ui`
 * (closure counts, de-duplicated); this file only draws them and forwards taps.
 *
 * The whole view state is one selection, `{ path, ungrouped }`. The renderer emits it through
 * `onNavigate` whenever the user changes it, so a host can put it in its URL, and takes it back
 * through `setSelection` (from the URL on load, or on Back) without echoing it. `items()` gives the
 * item ids the selection matches, so the host can filter its list without re-deriving the closure.
 *
 * ```ts
 * const chips = renderGroupChips(el, groups, {
 *   items: () => songs.map((s) => s.id),
 *   selection: { path: (url.searchParams.get('group') ?? '').split('/').filter(Boolean) },
 *   onNavigate: (sel) => { history.pushState(null, '', toUrl(sel)); showSongs(chips.items()); },
 * });
 * ```
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import {
  groupChipItems,
  normalizeChipSelection,
  sameChipSelection,
  toGroupChips,
  type GroupChip,
  type GroupChipsOptions,
  type GroupChipsSelection,
} from '@zodal/groups-ui';

export interface GroupChipsRendererOptions extends Omit<GroupChipsOptions, 'items' | 'selection' | 'allChipItems'> {
  /** The starting selection, e.g. from the URL. Default: All. */
  readonly selection?: Partial<GroupChipsSelection>;
  /**
   * The items to count and filter: a list, or a function read on every render (so a host whose
   * item list changes need not re-mount). Default: every non-group node in the space.
   */
  readonly items?: Iterable<NodeId> | (() => Iterable<NodeId>);
  /**
   * What the All chip stands for, when not the whole pool (a "recently viewed" home, say): a list,
   * or a function read on every render. Relabel the chip with `labels.all`. Default: the pool.
   */
  readonly allChipItems?: Iterable<NodeId> | (() => Iterable<NodeId>);
  /**
   * The selection changed: the user chose a chip, or a model change removed the chosen group.
   * Never called for `setSelection`.
   */
  readonly onNavigate?: (selection: GroupChipsSelection) => void;
  /** The widget's accessible name. Default "Browse groups". */
  readonly label?: string;
}

export interface GroupChipsRenderer {
  /** The selection shown (normalized: an invalid tail is dropped). */
  readonly selection: GroupChipsSelection;
  /** Show this selection (from the URL, on Back). Returns what is actually shown. No `onNavigate`. */
  setSelection(selection: Partial<GroupChipsSelection>): GroupChipsSelection;
  /** The item ids the current selection matches (the closure), in pool order. */
  items(): NodeId[];
  render(): void;
  destroy(): void;
  readonly element: HTMLElement;
}

export function renderGroupChips<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: GroupChipsRendererOptions = {},
): GroupChipsRenderer {
  const {
    onNavigate,
    selection: initial,
    items: itemsOption,
    allChipItems: allOption,
    label = 'Browse groups',
    ...viewOptions
  } = options;
  const read = (option: Iterable<NodeId> | (() => Iterable<NodeId>) | undefined): NodeId[] | undefined =>
    option === undefined ? undefined : [...(typeof option === 'function' ? option() : option)];
  const pool = (): NodeId[] | undefined => read(itemsOption);
  const allScope = (): { allChipItems?: NodeId[] } => {
    const all = read(allOption);
    return all ? { allChipItems: all } : {};
  };

  let selection = normalizeChipSelection(groups, initial);

  const root = document.createElement('div');
  root.className = 'zg-group-chips';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  container.appendChild(root);

  const render = (): void => {
    // Keep focus on the same chip across the redraw (by row depth + chip key: both stable).
    const focused = document.activeElement as HTMLElement | null;
    const focusAt = root.contains(focused) ? { depth: focused?.dataset.depth, key: focused?.dataset.key } : null;

    const items = pool();
    const view = toGroupChips(groups, { ...viewOptions, selection, ...(items ? { items } : {}), ...allScope() });
    selection = view.selection;

    root.replaceChildren(
      ...view.rows.map((row) => {
        const el = document.createElement('div');
        el.className = 'zg-group-chips-row';
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', row.label);
        el.dataset.depth = String(row.depth);
        el.append(...row.chips.map((chip) => renderChip(chip, row.depth)));
        return el;
      }),
    );

    if (focusAt) {
      const again = [...root.querySelectorAll<HTMLElement>('.zg-group-chip')].find(
        (b) => b.dataset.depth === focusAt.depth && b.dataset.key === focusAt.key,
      );
      again?.focus();
    }
  };

  const renderChip = (chip: GroupChip, depth: number): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `zg-group-chip is-${chip.kind}`;
    if (chip.hasChildren) button.classList.add('has-children');
    if (chip.onPath) button.classList.add('is-on-path');
    button.dataset.key = chip.key;
    button.dataset.depth = String(depth);
    if (chip.nodeId) button.dataset.nodeId = chip.nodeId;
    button.setAttribute('aria-pressed', String(chip.aria.pressed));
    button.setAttribute('aria-label', chip.aria.label);

    const text = document.createElement('span');
    text.className = 'zg-group-chip-label';
    text.textContent = chip.label;
    const count = document.createElement('span');
    count.className = 'zg-group-chip-count';
    count.textContent = String(chip.count);
    count.setAttribute('aria-hidden', 'true'); // in the accessible name already
    button.append(text, count);
    if (chip.hasChildren) {
      const more = document.createElement('span');
      more.className = 'zg-group-chip-more';
      more.textContent = '›';
      more.setAttribute('aria-hidden', 'true');
      button.appendChild(more);
    }

    button.addEventListener('click', () => {
      if (sameChipSelection(chip.target, selection)) return;
      selection = chip.target;
      render();
      // The newly opened row's first chip may be off-screen in a scrolling row: bring the chosen one in.
      const pressed = root.querySelectorAll<HTMLElement>('[aria-pressed="true"]');
      pressed[pressed.length - 1]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      onNavigate?.(selection);
    });
    return button;
  };

  // Counts follow the model; if a change removes the chosen group, say where we are now.
  const off = groups.subscribe(() => {
    const before = selection;
    render();
    if (!sameChipSelection(before, selection)) onNavigate?.(selection);
  });

  render();

  return {
    get selection() {
      return selection;
    },
    setSelection(next) {
      selection = normalizeChipSelection(groups, next);
      render();
      return selection;
    },
    items: () => groupChipItems(groups, selection, pool(), allScope()),
    render,
    element: root,
    destroy: () => {
      off();
      root.remove();
    },
  };
}
