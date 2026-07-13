/**
 * A vanilla Miller-columns renderer — the view that handles polyhierarchy best.
 *
 * Worth stating plainly, because it is counter-intuitive: this is a *better* default than the tree
 * for a polyhierarchical space, and not for aesthetic reasons. **A column stack is a path.** When
 * the user has clicked `Archive → Research → Reading`, the question "which of `Reading`'s three
 * parents am I looking at it under?" is answered by the screen itself — the answer is the column to
 * the left. The tree view has to *invent* an answer to that question, then key its expansion state
 * correctly so the node doesn't spontaneously open in two places, then explain the situation to a
 * screen reader. The column browser never asks the question.
 *
 * That is why the whole view state here is **one array** — the selection trail — where a tree needs
 * a `Set<pathKey>` of expansions plus a separate selection.
 */

import type { Groups, NodeId, PathNode } from '@zodal/groups-core';

export interface ColumnsRendererOptions {
  readonly onSelect?: (nodeId: NodeId, trail: readonly NodeId[]) => void;
  readonly onChange?: () => void;
  readonly draggable?: boolean;
}

export interface ColumnsRenderer {
  render(): void;
  /** Navigate to a node by its path — e.g. from a search result or a breadcrumb. */
  reveal(path: readonly NodeId[]): void;
  destroy(): void;
  readonly element: HTMLElement;
}

export function renderColumns<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: ColumnsRendererOptions = {},
): ColumnsRenderer {
  const { draggable = true } = options;

  /** The entire view state of a column browser. One array. */
  let trail: NodeId[] = [];
  let dragging: { nodeId: NodeId; parent?: NodeId } | null = null;

  const root = document.createElement('div');
  root.className = 'zg-columns';
  container.appendChild(root);

  const render = (): void => {
    const columns = groups.columns({ trail });
    root.replaceChildren(
      ...columns.map((column, columnIndex) => {
        const ul = document.createElement('ul');
        ul.className = 'zg-column';
        ul.setAttribute('role', 'listbox');
        if (column.parentLabel) ul.setAttribute('aria-label', column.parentLabel);

        for (const row of column.rows) {
          const li = document.createElement('li');
          li.className = 'zg-column-row';
          li.setAttribute('role', 'option');
          li.dataset.nodeId = row.nodeId;

          const isSelected = trail[columnIndex] === row.nodeId;
          li.setAttribute('aria-selected', String(isSelected));
          if (isSelected) li.classList.add('is-selected');
          li.tabIndex = isSelected ? 0 : -1;

          const label = document.createElement('span');
          label.className = 'zg-label';
          label.textContent = row.label;
          li.appendChild(label);

          if (row.otherParentCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'zg-badge';
            badge.textContent = `+${row.otherParentCount}`;
            badge.title = `Also in ${row.otherParentCount} other group${row.otherParentCount === 1 ? '' : 's'}`;
            li.appendChild(badge);
          }

          if (row.hasChildren) {
            const chevron = document.createElement('span');
            chevron.className = 'zg-chevron';
            chevron.textContent = '›';
            chevron.setAttribute('aria-hidden', 'true');
            li.appendChild(chevron);
          }

          li.addEventListener('click', () => {
            // Truncate the trail to this column, then append. The trail IS the path.
            trail = [...trail.slice(0, columnIndex), row.nodeId];
            options.onSelect?.(row.nodeId, trail);
            render();
          });

          if (draggable) attachDrag(li, row, column.parent);
          ul.appendChild(li);
        }

        return ul;
      }),
    );

    // Keep the newest column in view — the standard column-browser behaviour.
    root.scrollLeft = root.scrollWidth;
  };

  const attachDrag = (li: HTMLLIElement, row: PathNode, parent?: NodeId): void => {
    li.draggable = true;

    li.addEventListener('dragstart', () => {
      dragging = { nodeId: row.nodeId, ...(parent ? { parent } : {}) };
    });

    li.addEventListener('dragover', (e) => {
      if (!dragging || !row.hasChildren) return;
      const violations = groups.canAdd(dragging.nodeId, row.nodeId);
      const valid = violations.length === 0;
      const destructive = e.altKey && Boolean(dragging.parent);

      li.classList.toggle('is-drop-valid', valid && !destructive);
      li.classList.toggle('is-drop-move', valid && destructive);
      li.classList.toggle('is-drop-invalid', !valid);
      li.title = valid
        ? destructive
          ? 'Move here'
          : 'Add to this group'
        : explainViolation(groups, violations[0]!);

      if (valid) e.preventDefault();
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('is-drop-valid', 'is-drop-move', 'is-drop-invalid');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const ok =
        e.altKey && dragging.parent
          ? groups.move(dragging.nodeId, dragging.parent, row.nodeId).ok
          : groups.add(dragging.nodeId, row.nodeId).ok;
      if (ok) {
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
    reveal(path) {
      trail = [...path];
      render();
    },
    destroy: () => root.remove(),
  };
}

function explainViolation<P>(groups: Groups<P>, v: { code: string; message: string; path?: readonly NodeId[] }): string {
  if (v.code === 'cycle' && v.path?.length) {
    const labels = v.path.map((id) => groups.space.nodes.get(id)?.label ?? id);
    return `That would create a loop: ${labels.join(' → ')}.`;
  }
  return v.message;
}
