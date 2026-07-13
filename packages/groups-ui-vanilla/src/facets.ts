/**
 * A vanilla facet panel — hierarchical facets with de-duplicated counts.
 *
 * The two rules from the research, made concrete:
 *
 * - **Selecting a group means "this group OR anything beneath it".** Picking `animal` must find an
 *   item tagged only `poodle`. That is `expand: 'closure'`, and it is the default here.
 * - **Counts are de-duplicated over the closure, never summed from children.** An item reachable via
 *   two subgroups is counted once. The naive rollup gives a number that is *wrong rather than
 *   broken*, which is why it survives in production for years.
 *
 * Empty facets are hidden by default (Flamenco's invariant: never offer a path to zero results).
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import { toFacetRows } from '@zodal/groups-ui';

export interface FacetsRenderer {
  render(): void;
  readonly selected: ReadonlySet<NodeId>;
  destroy(): void;
  readonly element: HTMLElement;
}

export function renderFacets<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: {
    readonly onChange?: (selected: ReadonlySet<NodeId>) => void;
    readonly under?: NodeId;
  } = {},
): FacetsRenderer {
  let selected = new Set<NodeId>();

  const root = document.createElement('div');
  root.className = 'zg-facets';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Filter by group');
  container.appendChild(root);

  const render = (): void => {
    const rows = toFacetRows(groups, {
      selected,
      expand: 'closure',
      ...(options.under ? { under: options.under } : {}),
    });

    root.replaceChildren(
      ...rows.map((row) => {
        const label = document.createElement('label');
        label.className = 'zg-facet';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = row.selected;
        box.addEventListener('change', () => {
          selected = new Set(selected);
          if (box.checked) selected.add(row.group);
          else selected.delete(row.group);
          options.onChange?.(selected);
          render();
        });

        const text = document.createElement('span');
        text.className = 'zg-facet-label';
        text.textContent = row.label;

        const count = document.createElement('span');
        count.className = 'zg-facet-count';
        count.textContent = String(row.count);

        label.append(box, text, count);
        if (row.hasChildren) label.classList.add('has-children');
        return label;
      }),
    );
  };

  render();

  return {
    render,
    get selected() {
      return selected;
    },
    element: root,
    destroy: () => root.remove(),
  };
}
