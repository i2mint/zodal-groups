/**
 * A vanilla tree renderer — zero dependencies, correct ARIA, honest about polyhierarchy.
 *
 * This is the reference implementation of "render a `TreeRow[]`". It is deliberately small: all the
 * hard thinking (unfolding the DAG into paths, keying expansion vs. selection, computing
 * `aria-level`, deciding add-vs-move) already happened in `groups-core` and `groups-ui`. A renderer's
 * job is to draw rows and forward gestures — and the fact that this file is ~150 lines is the
 * evidence that the projection layer is carrying its weight.
 *
 * Three details are load-bearing and are the ones to copy when writing another renderer:
 *
 * 1. **`element.dataset.key = row.key` (the pathKey), never `row.nodeId`.** Duplicate DOM ids are
 *    invalid HTML and silently corrupt `aria-owns` and label associations.
 * 2. **A flat DOM with explicit `aria-level`/`aria-posinset`/`aria-setsize` on every row.** Once the
 *    DOM is flat (which virtualization forces anyway), structural nesting no longer conveys depth,
 *    so these attributes stop being optional.
 * 3. **Hovering a row highlights its twins** — the other places the same node appears. This is the
 *    cheapest possible way to teach "one thing, two places", and it is the affordance the folder
 *    metaphor simply cannot express.
 *
 * And three that make it usable by thumb and by keyboard (the touch pass):
 *
 * - **Activating a group row expands it** (`groupActivate: 'toggle'`, the default): on a phone the
 *   twisty is too small to be the only way in. `'select'` keeps the old behaviour, for a sidebar
 *   whose groups are destinations.
 * - **One tab stop, APG tree keys** (roving `tabindex`): ↑/↓ move, → expands or goes to the first
 *   child, ← collapses or goes to the parent, Home/End, Enter/Space activate.
 * - **Drag only under a fine pointer.** On touch a long-press drag fights scrolling; a touch user
 *   files things through a menu (`renderTagMenu`).
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import { toggleExpanded } from '@zodal/groups-core';
import { resolveDrop, applyDrop, toTreeRows, type TreeRow } from '@zodal/groups-ui';
import { FINE_POINTER, mediaMatches } from './media.js';

/** Elements whose clicks and keys belong to themselves, not to the row around them. */
const INTERACTIVE = 'button, a[href], input, select, textarea, label, [contenteditable=""], [contenteditable="true"]';

export interface TreeRendererOptions {
  /** A row was selected (a leaf, or a group when `groupActivate` is `'select'`). */
  readonly onSelect?: (nodeId: NodeId, row: TreeRow) => void;
  /** A group row was expanded or collapsed (by a tap, the twisty or a key). */
  readonly onToggle?: (nodeId: NodeId, expanded: boolean, row: TreeRow) => void;
  /** The model changed (a drop). */
  readonly onChange?: () => void;
  /** Show the "also in N groups" badge. Default `true`. */
  readonly showOtherParents?: boolean;
  /**
   * Enable drag-and-drop. Default `true`, which means: where the pointer is fine (mouse, trackpad,
   * stylus; `(pointer: fine)`). On touch a long-press drag fights scrolling, so rows are never
   * draggable there. `false` turns it off everywhere.
   */
  readonly draggable?: boolean;
  /**
   * What activating a **group** row (click, tap, Enter, Space) does. `'toggle'` (default) expands
   * or collapses it and selects nothing; `'select'` selects it, leaving the twisty to expand. Rows
   * without children are always selected.
   */
  readonly groupActivate?: 'toggle' | 'select';
  /**
   * A muted second line under the label ("Taylor Swift" under a song title). Return `undefined`
   * for none. It is added to the row's accessible name.
   */
  readonly subtitle?: (row: TreeRow) => string | undefined;
  /**
   * Draw the label yourself. `el` is the row's empty `.zg-label` span; fill it (a bold title and a
   * muted artist, an icon, a count). Wins over `subtitle`. The row's accessible name stays
   * `row.aria.label` (which carries "also in N other groups") unless `ariaLabel` is given.
   */
  readonly renderLabel?: (row: TreeRow, el: HTMLElement) => void;
  /** The row's accessible name. Default: `row.aria.label`, plus the subtitle if any. */
  readonly ariaLabel?: (row: TreeRow) => string;
  /** The tree's own accessible name. */
  readonly label?: string;
}

export interface TreeRenderer {
  /** Re-render from the current model + view state. */
  render(): void;
  destroy(): void;
  readonly element: HTMLElement;
}

/**
 * Mount a tree into a container.
 *
 * View state (expansion, selection, the focused row) lives here, in the renderer — not in the
 * model. The model holds membership; a tree's open/closed state is a fact about *this view*, and
 * two trees over the same space can legitimately disagree about it.
 */
export function renderTree<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: TreeRendererOptions = {},
): TreeRenderer {
  const { showOtherParents = true, draggable = true, groupActivate = 'toggle' } = options;

  let expanded = new Set<string>();
  let selected = new Set<NodeId>();
  /** The row holding the tab stop, by PATH (two appearances of a node are two stops). */
  let focusKey: string | null = null;
  let dragging: TreeRow | null = null;
  let rows: TreeRow[] = [];

  const root = document.createElement('ul');
  root.className = 'zg-tree';
  root.setAttribute('role', 'tree');
  if (options.label) root.setAttribute('aria-label', options.label);
  container.appendChild(root);

  /**
   * pathKey → element, rebuilt each render.
   *
   * We look twins up here rather than with a CSS attribute selector: a `pathKey` is a joined path
   * and may contain any character an id may contain, so building a selector from one is a
   * quoting/escaping hazard for no benefit. A map is both safer and faster.
   */
  const rowElements = new Map<string, HTMLLIElement>();

  const expandable = (row: TreeRow): boolean => row.hasChildren && !row.isRecursive;

  const render = (): void => {
    const hadFocus = root.contains(document.activeElement);
    rowElements.clear();
    rows = toTreeRows(groups, { expanded, selected });
    // The tab stop: the focused row if it is still shown, else the first selected row, else the first.
    if (!focusKey || !rows.some((r) => r.key === focusKey)) {
      focusKey = (rows.find((r) => r.selected) ?? rows[0])?.key ?? null;
    }
    const canDrag = draggable && mediaMatches(FINE_POINTER);
    root.replaceChildren(...rows.map((row) => renderRow(row, canDrag)));
    if (hadFocus && focusKey) rowElements.get(focusKey)?.focus({ preventScroll: true });
  };

  const toggle = (row: TreeRow): void => {
    focusKey = row.key;
    expanded = toggleExpanded(expanded, row.key); // keyed by PATH — see D13
    render();
    options.onToggle?.(row.nodeId, expanded.has(row.key), row);
  };

  const select = (row: TreeRow): void => {
    focusKey = row.key;
    selected = new Set([row.nodeId]); // keyed by NODE — one thing, however many places
    render();
    options.onSelect?.(row.nodeId, row);
  };

  const activate = (row: TreeRow): void => {
    if (expandable(row) && groupActivate === 'toggle') toggle(row);
    else select(row);
  };

  const moveFocus = (key: string | undefined): void => {
    if (!key) return;
    focusKey = key;
    for (const [k, el] of rowElements) el.tabIndex = k === key ? 0 : -1;
    rowElements.get(key)?.focus();
  };

  // APG tree keys, on the tree (one listener; the row comes from the focused element).
  // Only keys aimed at the row itself: a control a host drew inside the label (`renderLabel`) keeps
  // its own Space and Enter.
  root.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (!el.classList?.contains('zg-row')) return;
    const index = rows.findIndex((r) => r.key === el.dataset.key);
    const row = rows[index];
    if (!row) return;
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(rows[index + 1]?.key);
        break;
      case 'ArrowUp':
        moveFocus(rows[index - 1]?.key);
        break;
      case 'Home':
        moveFocus(rows[0]?.key);
        break;
      case 'End':
        moveFocus(rows[rows.length - 1]?.key);
        break;
      case 'ArrowRight':
        if (expandable(row) && !row.expanded) toggle(row);
        else if (expandable(row) && rows[index + 1]?.depth === row.depth + 1) moveFocus(rows[index + 1]!.key);
        break;
      case 'ArrowLeft':
        if (expandable(row) && row.expanded) toggle(row);
        else {
          // The parent is the nearest row above at one level up: the path that led here.
          for (let i = index - 1; i >= 0; i--) {
            if (rows[i]!.depth === row.depth - 1) {
              moveFocus(rows[i]!.key);
              break;
            }
          }
        }
        break;
      case 'Enter':
      case ' ':
        activate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  const renderRow = (row: TreeRow, canDrag: boolean): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'zg-row';
    li.setAttribute('role', 'treeitem');

    // The DOM key is the PATH, not the node. See the module docstring.
    li.dataset.key = row.key;
    li.dataset.nodeId = row.nodeId;

    li.setAttribute('aria-level', String(row.aria.level));
    li.setAttribute('aria-posinset', String(row.aria.posinset));
    li.setAttribute('aria-setsize', String(row.aria.setsize));
    li.setAttribute('aria-selected', String(row.aria.selected));
    if (row.aria.expanded !== undefined) li.setAttribute('aria-expanded', String(row.aria.expanded));
    li.style.setProperty('--zg-depth', String(row.depth));
    li.tabIndex = row.key === focusKey ? 0 : -1; // roving: exactly one tab stop

    if (row.selected) li.classList.add('is-selected');
    if (row.isRecursive) li.classList.add('is-recursive');
    if (expandable(row)) li.classList.add('has-children');

    // Expander: the full row height, and a thumb wide on a coarse pointer (styles.css).
    const twisty = document.createElement('span');
    twisty.className = 'zg-twisty';
    twisty.textContent = expandable(row) ? (row.expanded ? '▾' : '▸') : '';
    twisty.setAttribute('aria-hidden', 'true');
    if (expandable(row)) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(row);
      });
    }
    li.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'zg-label';
    const subtitle = options.renderLabel ? undefined : options.subtitle?.(row);
    if (options.renderLabel) {
      options.renderLabel(row, label);
    } else if (subtitle) {
      const title = document.createElement('span');
      title.className = 'zg-label-title';
      title.textContent = row.label;
      const sub = document.createElement('span');
      sub.className = 'zg-label-subtitle';
      sub.textContent = subtitle;
      label.append(title, sub);
    } else {
      label.textContent = row.label;
    }
    li.appendChild(label);
    li.setAttribute(
      'aria-label',
      options.ariaLabel?.(row) ??
        (subtitle && row.aria.label.startsWith(row.label)
          ? `${row.label}, ${subtitle}${row.aria.label.slice(row.label.length)}`
          : row.aria.label),
    );

    // "also in N other groups" — the affordance a tree cannot otherwise have.
    if (showOtherParents && row.otherParentCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'zg-badge';
      badge.textContent = `+${row.otherParentCount}`;
      badge.title = `Also in ${row.otherParentCount} other group${row.otherParentCount === 1 ? '' : 's'}`;
      badge.setAttribute('aria-hidden', 'true'); // already in the accessible name
      li.appendChild(badge);
    }

    if (row.isRecursive) {
      const mark = document.createElement('span');
      mark.className = 'zg-recursive';
      mark.textContent = '↻ already shown above';
      li.appendChild(mark);
    }

    li.addEventListener('click', (e) => {
      // A click on a host control inside the label is the control's, not the row's.
      const target = e.target as HTMLElement;
      if (target !== li && target.closest?.(INTERACTIVE)?.closest('li.zg-row') === li) return;
      activate(row);
    });

    // Cross-highlight the twins: the cheapest way to teach "same thing, two places". Only where
    // there is a hover: on touch, a tap fires `mouseenter` and the highlight would stick.
    li.addEventListener('mouseenter', () => {
      if (!mediaMatches('(hover: hover)')) return;
      for (const key of row.twinKeys) rowElements.get(key)?.classList.add('is-twin');
    });
    li.addEventListener('mouseleave', () => {
      for (const key of row.twinKeys) rowElements.get(key)?.classList.remove('is-twin');
    });

    if (canDrag) attachDrag(li, row);
    rowElements.set(row.key, li);
    return li;
  };

  const attachDrag = (li: HTMLLIElement, row: TreeRow): void => {
    li.draggable = true;

    li.addEventListener('dragstart', (e) => {
      dragging = row;
      e.dataTransfer?.setData('text/plain', row.nodeId);
    });

    li.addEventListener('dragover', (e) => {
      if (!dragging) return;
      const drop = resolveDrop(groups, {
        source: dragging.source,
        target: row.source,
        modifiers: { alt: e.altKey },
      });

      // Always show *something*, including a reason for refusal. A drop target that just says no is
      // indistinguishable from a bug, because the cycle may close through an off-screen branch.
      li.classList.toggle('is-drop-valid', drop.valid && !drop.destructive);
      li.classList.toggle('is-drop-move', drop.valid && drop.destructive);
      li.classList.toggle('is-drop-invalid', !drop.valid);
      li.title = drop.reason ?? (drop.destructive ? 'Move here (removes it from its current group)' : 'Add to this group');

      if (drop.valid) e.preventDefault(); // permit the drop
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('is-drop-valid', 'is-drop-move', 'is-drop-invalid');
      li.title = '';
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const drop = resolveDrop(groups, {
        source: dragging.source,
        target: row.source,
        modifiers: { alt: e.altKey },
      });
      if (applyDrop(groups, drop)) {
        options.onChange?.();
        render();
      }
      li.classList.remove('is-drop-valid', 'is-drop-move', 'is-drop-invalid');
      dragging = null;
    });
  };

  render();

  return {
    render,
    element: root,
    destroy: () => root.remove(),
  };
}
