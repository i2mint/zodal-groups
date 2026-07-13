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
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import { toggleExpanded } from '@zodal/groups-core';
import { resolveDrop, applyDrop, toTreeRows, type TreeRow } from '@zodal/groups-ui';

export interface TreeRendererOptions {
  readonly onSelect?: (nodeId: NodeId, row: TreeRow) => void;
  readonly onChange?: () => void;
  /** Show the "also in N groups" badge. Default `true`. */
  readonly showOtherParents?: boolean;
  /** Enable drag-and-drop. Default `true`. */
  readonly draggable?: boolean;
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
 * View state (expansion, selection) lives here, in the renderer — not in the model. The model holds
 * membership; a tree's open/closed state is a fact about *this view*, and two trees over the same
 * space can legitimately disagree about it.
 */
export function renderTree<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: TreeRendererOptions = {},
): TreeRenderer {
  const { showOtherParents = true, draggable = true } = options;

  let expanded = new Set<string>();
  let selected = new Set<NodeId>();
  let dragging: TreeRow | null = null;

  const root = document.createElement('ul');
  root.className = 'zg-tree';
  root.setAttribute('role', 'tree');
  container.appendChild(root);

  /**
   * pathKey → element, rebuilt each render.
   *
   * We look twins up here rather than with a CSS attribute selector: a `pathKey` is a joined path
   * and may contain any character an id may contain, so building a selector from one is a
   * quoting/escaping hazard for no benefit. A map is both safer and faster.
   */
  const rowElements = new Map<string, HTMLLIElement>();

  const render = (): void => {
    rowElements.clear();
    const rows = toTreeRows(groups, { expanded, selected });
    root.replaceChildren(...rows.map(renderRow));
  };

  const renderRow = (row: TreeRow): HTMLLIElement => {
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
    li.setAttribute('aria-label', row.aria.label);
    li.style.setProperty('--zg-depth', String(row.depth));
    li.tabIndex = row.selected ? 0 : -1;

    if (row.selected) li.classList.add('is-selected');
    if (row.isRecursive) li.classList.add('is-recursive');

    // Expander.
    const twisty = document.createElement('span');
    twisty.className = 'zg-twisty';
    twisty.textContent = row.hasChildren ? (row.expanded ? '▾' : '▸') : '';
    twisty.setAttribute('aria-hidden', 'true');
    if (row.hasChildren) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = toggleExpanded(expanded, row.key); // keyed by PATH — see D13
        render();
      });
    }
    li.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'zg-label';
    label.textContent = row.label;
    li.appendChild(label);

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

    // Selection is keyed by NODE — one thing, however many places it appears.
    li.addEventListener('click', () => {
      selected = new Set([row.nodeId]);
      options.onSelect?.(row.nodeId, row);
      render();
    });

    // Cross-highlight the twins: the cheapest way to teach "same thing, two places".
    li.addEventListener('mouseenter', () => {
      for (const key of row.twinKeys) rowElements.get(key)?.classList.add('is-twin');
    });
    li.addEventListener('mouseleave', () => {
      for (const key of row.twinKeys) rowElements.get(key)?.classList.remove('is-twin');
    });

    if (draggable) attachDrag(li, row);
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
