/**
 * A vanilla multi-family facet sidebar: one button per family, an inline "any of" panel of
 * checkboxes with counts, and the applied filters as removable chips (`Genre: Rock or Jazz` and
 * `Mood: Calm`).
 *
 * Everything it shows comes from `toFacetSidebar` in `@zodal/groups-ui` (OR within a family, AND
 * between families, each family counted over what the others leave). This file draws the view,
 * forwards clicks, and keeps focus on the control the user was on across redraws.
 *
 * The state is the host's to keep (in its URL, say): the selected value ids, and which panel is
 * open. `onSelect` gets every new selection; `setSelected` takes one back without echoing it.
 * `items()` is what the selection matches, so the host can filter its list.
 *
 * ```ts
 * const sidebar = renderFacetSidebar(el, groups, {
 *   families: ['genre', 'mood'],
 *   items: () => songs.map((s) => s.id),
 *   onSelect: () => showSongs(sidebar.items()),
 * });
 * ```
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import {
  clearFacetFamily,
  toFacetSidebar,
  toggleFacetValue,
  type FacetSidebarFamily,
  type FacetSidebarOptions,
  type FacetSidebarView,
} from '@zodal/groups-ui';

export interface FacetSidebarRendererOptions extends Omit<FacetSidebarOptions, 'items' | 'selected' | 'open'> {
  /** The starting selection (value ids, across families), e.g. from the URL. */
  readonly selected?: Iterable<NodeId | string>;
  /** The family whose panel starts open. Default: none. */
  readonly open?: NodeId | string | null;
  /**
   * The items to count and filter: a list, or a function read on every render (so a host whose
   * item list changes need not re-mount). Default: every non-group node in the space.
   */
  readonly items?: Iterable<NodeId> | (() => Iterable<NodeId>);
  /**
   * The selection changed: a box ticked or unticked, a chip removed, a clear, or a model change
   * that removed a selected value. Never called for `setSelected`.
   */
  readonly onSelect?: (selected: ReadonlySet<NodeId>, view: FacetSidebarView) => void;
  /** A family's panel opened, or the open one closed (`null`). */
  readonly onOpen?: (family: NodeId | null) => void;
  /** The widget's accessible name. Default "Filters". */
  readonly label?: string;
}

export interface FacetSidebarRenderer {
  /** The selection applied (normalized: values of no listed family are dropped). */
  readonly selected: ReadonlySet<NodeId>;
  /** The family whose panel is open. */
  readonly open: NodeId | null;
  /** Show this selection (from the URL, on Back). Returns what is applied. No `onSelect`. */
  setSelected(selected: Iterable<NodeId | string>): ReadonlySet<NodeId>;
  /** Open a family's panel, or close the open one (`null`). No `onOpen`. */
  setOpen(family: NodeId | string | null): void;
  /** The item ids the selection matches, in pool order. */
  items(): NodeId[];
  /** The current view. */
  view(): FacetSidebarView;
  render(): void;
  destroy(): void;
  readonly element: HTMLElement;
}

let instances = 0;

export function renderFacetSidebar<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: FacetSidebarRendererOptions,
): FacetSidebarRenderer {
  const { onSelect, onOpen, items: itemsOption, selected: initial, open: initialOpen, label = 'Filters', ...viewOptions } = options;
  const id = `zg-facet-sidebar-${(instances += 1)}`;
  const pool = (): NodeId[] | undefined =>
    itemsOption === undefined ? undefined : [...(typeof itemsOption === 'function' ? itemsOption() : itemsOption)];

  let selected: ReadonlySet<NodeId> = new Set();
  let open: NodeId | null = null;
  let current: FacetSidebarView;

  const compute = (sel: Iterable<NodeId | string>, opened: NodeId | string | null): FacetSidebarView => {
    const items = pool();
    const view = toFacetSidebar(groups, { values: 'open', ...viewOptions, selected: sel, open: opened, ...(items ? { items } : {}) });
    selected = view.selected;
    open = view.open;
    current = view;
    return view;
  };

  const root = document.createElement('div');
  root.className = 'zg-facet-sidebar';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  // Persistent, outside the redrawn part: a live region must exist before its text changes.
  const body = document.createElement('div');
  body.className = 'zg-facet-sidebar-body';
  const live = document.createElement('div');
  live.className = 'zg-facet-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.append(body, live);
  container.appendChild(root);

  const sameSet = (a: ReadonlySet<NodeId>, b: ReadonlySet<NodeId>) => a.size === b.size && [...a].every((x) => b.has(x));

  /** Change the selection from a user gesture: redraw, then tell the host. */
  const select = (next: Iterable<NodeId>): void => {
    compute(next, open);
    draw();
    onSelect?.(selected, current);
  };

  const button = (className: string, text: string, focusKey: string, family?: NodeId): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.dataset.focusKey = focusKey;
    if (family !== undefined) b.dataset.family = family;
    return b;
  };

  const drawApplied = (view: FacetSidebarView): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'zg-facet-applied';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', view.labels.applied);
    el.hidden = view.applied.length === 0;
    view.applied.forEach((applied, i) => {
      if (i) {
        const and = document.createElement('span');
        and.className = 'zg-facet-and';
        and.textContent = view.labels.and;
        el.appendChild(and);
      }
      const group = document.createElement('span');
      group.className = 'zg-facet-applied-family';
      const name = document.createElement('span');
      name.className = 'zg-facet-applied-label';
      name.textContent = `${applied.label}:`;
      group.appendChild(name);
      applied.values.forEach((value, j) => {
        if (j) {
          const or = document.createElement('span');
          or.className = 'zg-facet-or';
          or.textContent = view.labels.or;
          group.appendChild(or);
        }
        const chip = button('zg-facet-chip', '', `chip:${applied.family}:${value.group}`, applied.family);
        chip.dataset.nodeId = value.group;
        chip.setAttribute('aria-label', value.removeLabel);
        const text = document.createElement('span');
        text.textContent = value.label;
        const x = document.createElement('span');
        x.className = 'zg-facet-chip-x';
        x.textContent = '×';
        x.setAttribute('aria-hidden', 'true');
        chip.append(text, x);
        chip.addEventListener('click', () => select(toggleFacetValue(selected, value.group)));
        group.appendChild(chip);
      });
      el.appendChild(group);
    });
    if (view.applied.length) {
      const all = button('zg-facet-clear-all', view.labels.clearAll, 'clear-all');
      all.addEventListener('click', () => select([]));
      el.appendChild(all);
    }
    return el;
  };

  const drawFamily = (family: FacetSidebarFamily, index: number, view: FacetSidebarView): HTMLElement => {
    const section = document.createElement('div');
    section.className = 'zg-facet-family';
    section.dataset.nodeId = family.family;
    const panelId = `${id}-p${index}`; // by position: a node id may hold spaces, which break IDREFs

    const toggle = button('zg-facet-family-toggle', '', `family:${family.family}`, family.family);
    toggle.setAttribute('aria-expanded', String(family.aria.expanded));
    toggle.setAttribute('aria-controls', panelId);
    toggle.setAttribute('aria-label', family.aria.label);
    const name = document.createElement('span');
    name.className = 'zg-facet-family-label';
    name.textContent = family.label;
    toggle.appendChild(name);
    if (family.selectedCount) {
      const badge = document.createElement('span');
      badge.className = 'zg-facet-family-badge';
      badge.textContent = String(family.selectedCount);
      badge.setAttribute('aria-hidden', 'true'); // in the accessible name already
      toggle.appendChild(badge);
    }
    toggle.addEventListener('click', () => {
      compute(selected, open === family.family ? null : family.family);
      draw();
      onOpen?.(open);
    });
    section.appendChild(toggle);

    const panel = document.createElement('div');
    panel.className = 'zg-facet-family-panel zg-facets';
    panel.id = panelId;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', family.aria.panelLabel);
    panel.hidden = !family.open;
    if (family.open) {
      for (const value of family.values) {
        const row = document.createElement('label');
        row.className = 'zg-facet';
        if (value.hasChildren) row.classList.add('has-children');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = value.aria.checked;
        box.dataset.focusKey = `value:${value.key}`;
        box.dataset.family = family.family;
        box.dataset.nodeId = value.group;
        box.setAttribute('aria-label', value.aria.label);
        box.addEventListener('change', () => select(toggleFacetValue(selected, value.group)));
        const text = document.createElement('span');
        text.className = 'zg-facet-label';
        text.textContent = value.label;
        const count = document.createElement('span');
        count.className = 'zg-facet-count';
        count.textContent = String(value.count);
        count.setAttribute('aria-hidden', 'true');
        row.append(box, text, count);
        panel.appendChild(row);
      }
      if (!family.values.length) {
        const none = document.createElement('p');
        none.className = 'zg-facet-none';
        none.textContent = view.labels.none;
        panel.appendChild(none);
      }
      if (family.selectedCount) {
        const clear = button('zg-facet-clear', view.labels.clear, `clear:${family.family}`, family.family);
        clear.addEventListener('click', () => select(clearFacetFamily(groups, selected, family.family)));
        panel.appendChild(clear);
      }
    }
    section.appendChild(panel);
    return section;
  };

  const draw = (): void => {
    // Keep focus on the same control across the redraw. If it is gone (a removed chip, a cleared
    // family, a value hidden at zero), hand focus to its family's button; else the first one.
    const doc = root.getRootNode() as Document | ShadowRoot;
    const focused = (doc.activeElement ?? null) as HTMLElement | null;
    const at = focused && body.contains(focused) ? { key: focused.dataset.focusKey, family: focused.dataset.family } : null;

    const view = current;
    body.replaceChildren(drawApplied(view), ...view.families.map((f, i) => drawFamily(f, i, view)));
    const said = view.summary ? `${view.summary}. ${view.labels.matching(view.matching.length)}` : '';
    if (live.textContent !== said) live.textContent = said;

    if (at) {
      const controls = [...body.querySelectorAll<HTMLElement>('[data-focus-key]')];
      const same = controls.find((el) => el.dataset.focusKey === at.key);
      const home = at.family !== undefined ? controls.find((el) => el.dataset.focusKey === `family:${at.family}`) : undefined;
      (same ?? home ?? body.querySelector<HTMLElement>('.zg-facet-family-toggle'))?.focus();
    }
  };

  const render = (): void => {
    compute(selected, open);
    draw();
  };

  compute(initial ?? [], initialOpen ?? null);
  draw();

  // Counts follow the model; if a change removes a selected value, say what is applied now.
  const off = groups.subscribe(() => {
    const before = selected;
    render();
    if (!sameSet(before, selected)) onSelect?.(selected, current);
  });

  return {
    get selected() {
      return selected;
    },
    get open() {
      return open;
    },
    setSelected(next) {
      compute(next, open);
      draw();
      return selected;
    },
    setOpen(family) {
      compute(selected, family);
      draw();
    },
    // A host list given as a function may have changed since the last render: recompute then.
    items: () => [...(typeof itemsOption === 'function' ? compute(selected, open) : current).matching],
    view: () => current,
    render,
    element: root,
    destroy: () => {
      off();
      root.remove();
    },
  };
}
