/**
 * A vanilla selection-tagging menu — Gmail's label menu over a selection, staged until "Apply".
 *
 * Everything it shows comes from `@zodal/groups-ui`'s tagging session: the none/some/all state of
 * each group, the click cycle, why a group would be refused, the staged-changes summary and the plan.
 * This file only draws it and forwards keys and clicks, which is why it is short.
 *
 * The ARIA shape is the APG combobox with a listbox popup (GitHub Primer's SelectPanel is the same
 * shape): **focus stays in the search field** and `aria-activedescendant` points at the active
 * option, so typing always filters, arrows always move, and nothing the user typed is ever lost —
 * the field is created once and never re-rendered. Options are `role="option"` in a multiselectable
 * listbox and carry the tri-state as `aria-checked="true" | "false" | "mixed"`. A refused option
 * stays reachable (`aria-disabled`, not removed): its reason is the thing the user needs to read,
 * so it is wired as the option's description and also shown inline.
 *
 * Keys, in the search field: ↓/↑ move the active option; Enter toggles it (or creates the typed
 * group); Ctrl/⌘+Enter applies; Escape asks the host to close (`onClose`) and keeps the text.
 *
 * Nothing is written until Apply. The write is the host's (`onApply` receives the plan — call
 * `collection.bulkTag` per batch, or apply `planToDelta` to a store); with a `Groups` handle as the
 * source it defaults to applying there. The outcome is announced in a polite live region:
 * *"Applied: tagged 12 items, 2 refused: …"*. A write that throws keeps everything staged.
 */

import type { NodeId } from '@zodal/groups-core';
import {
  applyTagging,
  createTaggingSession,
  type ApplyOutcome,
  type SpaceSource,
  type TaggingOptions,
  type TaggingPlan,
  type TaggingSession,
  type TaggingView,
  type TagRow,
} from '@zodal/groups-ui';

export interface TagMenuOptions extends TaggingOptions {
  /**
   * Write the plan; resolve with what happened (a groups-collection `OperationResult` fits, or one
   * per batch). Required unless the source is a `Groups` handle, which it then defaults to.
   */
  readonly onApply?: (plan: TaggingPlan) => ApplyOutcome | readonly ApplyOutcome[] | Promise<ApplyOutcome | readonly ApplyOutcome[]>;
  /** Escape or Cancel: the host closes its popover. The typed text is kept either way. */
  readonly onClose?: () => void;
  /** After every staged change (toggle, create, reset) and after an apply. */
  readonly onChange?: (view: TaggingView) => void;
  /** Focus the search field on mount. Default `true` (the menu was just opened). */
  readonly autoFocus?: boolean;
  /** The menu's accessible name. Default: the list label ("Groups for 12 selected items"). */
  readonly label?: string;
}

export interface TagMenuRenderer {
  readonly element: HTMLElement;
  /** The search field — the one element that holds focus. */
  readonly search: HTMLInputElement;
  readonly session: TaggingSession;
  /** The model or the selection changed (a new selection drops what was staged). */
  update(next: { readonly source?: SpaceSource; readonly selection?: Iterable<NodeId | string> }): void;
  render(): void;
  /** Apply what is staged, as the button does. Resolves with the live-region sentence. */
  apply(): Promise<string>;
  destroy(): void;
}

const CREATE_KEY = '\u0000create';
let instances = 0;

const isGroupsHandle = (x: unknown): x is Parameters<typeof applyTagging>[0] =>
  typeof x === 'object' && x !== null && 'space' in x && typeof (x as { apply?: unknown }).apply === 'function';

/** Write only when different: re-setting a live region's text would announce it again. */
const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

export function renderTagMenu<P>(
  container: HTMLElement,
  source: SpaceSource<P>,
  options: TagMenuOptions,
): TagMenuRenderer {
  const onApply =
    options.onApply ??
    (isGroupsHandle(source) ? (plan: TaggingPlan) => applyTagging(source, plan) : undefined);
  if (!onApply) {
    throw new Error(
      'renderTagMenu: pass `onApply` (e.g. plan => Promise.all(plan.batches.map(b => collection.bulkTag(b.ids, b.change)))) — ' +
        'a GroupSpace alone cannot be written to. A Groups handle as the source needs none.',
    );
  }

  const session = createTaggingSession(source, options);
  const uid = `zg-tagmenu-${++instances}`;
  const ids = { list: `${uid}-list`, summary: `${uid}-summary`, conflicts: `${uid}-conflicts`, live: `${uid}-live` };

  let activeKey: string | null = null;
  let busy = false;

  // ── the skeleton: built once, so the search field (and its text, caret, focus) is never replaced ──
  const root = document.createElement('div');
  root.className = 'zg-tagmenu';
  root.setAttribute('role', 'group');

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'zg-tagmenu-search';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-expanded', 'true');
  search.setAttribute('aria-controls', ids.list);
  search.setAttribute('aria-autocomplete', 'list');

  const list = document.createElement('ul');
  list.className = 'zg-tagmenu-list';
  list.id = ids.list;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');

  const empty = document.createElement('p');
  empty.className = 'zg-tagmenu-empty';

  const footer = document.createElement('div');
  footer.className = 'zg-tagmenu-footer';
  const summary = document.createElement('ul');
  summary.className = 'zg-tagmenu-summary';
  summary.id = ids.summary;
  const conflicts = document.createElement('div');
  conflicts.className = 'zg-tagmenu-conflicts';
  conflicts.id = ids.conflicts;
  conflicts.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'zg-tagmenu-actions';
  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'zg-tagmenu-apply';
  applyButton.setAttribute('aria-describedby', `${ids.summary} ${ids.conflicts}`);
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'zg-tagmenu-cancel';
  actions.append(cancelButton, applyButton);
  footer.append(summary, conflicts, actions);

  // Present from the start: a live region added at announcement time is often not read.
  const live = document.createElement('div');
  live.className = 'zg-tagmenu-live';
  live.id = ids.live;
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  root.append(search, list, empty, footer, live);
  container.appendChild(root);

  /** The keys of the options currently shown, in order (groups, then the create option). */
  let visibleKeys: string[] = [];

  const optionFor = (row: TagRow, index: number, t: TaggingView['messages']['tagging']): HTMLLIElement => {
    const li = document.createElement('li');
    li.id = `${uid}-o${index}`; // by position: a group id may hold any character, a DOM id may not
    li.className = 'zg-tagmenu-option';
    li.dataset.key = row.group;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-checked', row.aria.checked);
    li.setAttribute('aria-label', row.aria.label);
    if (row.aria.disabled) li.setAttribute('aria-disabled', 'true');
    li.classList.toggle('is-pending', row.pending);
    li.classList.toggle('is-new', row.isNew);
    li.classList.toggle('is-disabled', row.disabled);
    li.dataset.state = row.state;

    const box = document.createElement('span');
    box.className = 'zg-tagmenu-box';
    box.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'zg-tagmenu-text';
    const label = document.createElement('span');
    label.className = 'zg-tagmenu-label';
    label.textContent = row.label;
    text.appendChild(label);
    if (row.path) {
      const path = document.createElement('span');
      path.className = 'zg-tagmenu-path';
      path.textContent = row.path;
      text.appendChild(path);
    }

    const count = document.createElement('span');
    count.className = 'zg-tagmenu-count';
    count.setAttribute('aria-hidden', 'true'); // already in the accessible name
    if (row.originalState === 'some') count.textContent = t.countOf(row.count, row.total);

    li.append(box, text, count);

    if (row.aria.description) {
      const reason = document.createElement('div');
      reason.className = 'zg-tagmenu-reason';
      reason.id = `${li.id}-reason`;
      reason.textContent = row.aria.description;
      li.setAttribute('aria-describedby', reason.id);
      li.appendChild(reason);
    }
    return li;
  };

  const render = (): void => {
    const view = session.view();
    const t = view.messages.tagging;

    search.setAttribute('aria-label', t.searchLabel);
    search.placeholder = t.searchPlaceholder(options.allowCreate !== false);
    list.setAttribute('aria-label', t.listLabel(view.selection.length));
    root.setAttribute('aria-label', options.label ?? t.listLabel(view.selection.length));
    root.setAttribute('aria-busy', String(busy));

    const items = view.rows.map((row, i) => optionFor(row, i, t));
    if (view.create) {
      const li = document.createElement('li');
      li.id = `${uid}-o${items.length}`;
      li.className = 'zg-tagmenu-option zg-tagmenu-create';
      li.dataset.key = CREATE_KEY;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-checked', 'false');
      li.textContent = view.create.text;
      if (!view.create.allowed) {
        li.setAttribute('aria-disabled', 'true');
        li.classList.add('is-disabled');
        if (view.create.reason) {
          const reason = document.createElement('div');
          reason.className = 'zg-tagmenu-reason';
          reason.id = `${li.id}-reason`;
          reason.textContent = view.create.reason;
          li.setAttribute('aria-describedby', reason.id);
          li.appendChild(reason);
        }
      }
      items.push(li);
    }
    list.replaceChildren(...items);
    visibleKeys = items.map((li) => li.dataset.key!);

    // The active option follows the model (a group id), so it survives filtering and re-renders.
    if (!activeKey || !visibleKeys.includes(activeKey)) activeKey = visibleKeys[0] ?? null;
    const active = activeKey ? items[visibleKeys.indexOf(activeKey)] : undefined;
    for (const li of items) li.classList.toggle('is-active', li === active);
    if (active) {
      search.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');

    setText(empty, view.empty ?? '');
    empty.hidden = !view.empty;

    summary.replaceChildren(
      ...view.summary.map((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        return li;
      }),
    );
    setText(conflicts, view.plan.conflicts.map((c) => (c.fix ? `${c.message} ${c.fix}` : c.message)).join(' '));
    conflicts.hidden = view.plan.conflicts.length === 0;

    setText(applyButton, busy ? t.applying : view.applyLabel);
    applyButton.disabled = busy || !view.canApply;
    setText(cancelButton, t.cancelButton);
  };

  const changed = (): void => options.onChange?.(session.view());

  /** Toggle a group, or create the typed one. Ignored while a write is in flight. */
  const activate = (key: string): void => {
    if (busy) return;
    if (key === CREATE_KEY) {
      const create = session.view().create;
      if (!create?.allowed) return;
      session.create();
      activeKey = create.group;
    } else {
      activeKey = key;
      session.toggle(key);
    }
    render();
    changed();
  };

  const move = (step: number): void => {
    if (!visibleKeys.length) return;
    const at = activeKey ? visibleKeys.indexOf(activeKey) : -1;
    const next = Math.min(visibleKeys.length - 1, Math.max(0, at + step));
    activeKey = visibleKeys[next]!;
    render();
  };

  const announce = (text: string): void => {
    // Clear first so the same sentence twice in a row is still announced.
    live.textContent = '';
    live.textContent = text;
  };

  const apply = async (): Promise<string> => {
    if (busy || !session.view().canApply) return '';
    busy = true;
    render();
    const plan = session.apply();
    let text: string;
    try {
      text = session.complete(await onApply(plan));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      text = session.view().messages.tagging.applyFailed(/[.!?]$/.test(reason) ? reason : `${reason}.`);
    } finally {
      busy = false;
    }
    render();
    announce(text);
    changed();
    // The Apply button is disabled now: hand focus back to the search rather than to <body>.
    if (!root.contains(document.activeElement) || document.activeElement === applyButton) search.focus();
    return text;
  };

  // ── events ──
  search.addEventListener('input', () => {
    session.setQuery(search.value);
    render();
  });

  search.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) void apply();
        else if (activeKey) activate(activeKey);
        break;
      case 'Escape':
        if (options.onClose) {
          e.preventDefault();
          options.onClose();
        }
        break;
    }
  });

  // Keep focus in the search field when an option is clicked: the field is the keyboard's home.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('[role="option"]');
    if (li?.dataset.key) activate(li.dataset.key);
  });

  applyButton.addEventListener('click', () => void apply());
  cancelButton.addEventListener('click', () => {
    if (!busy) session.reset();
    render();
    changed();
    options.onClose?.();
  });

  const unsubscribe = session.subscribe(render);
  render();
  if (options.autoFocus !== false) search.focus();

  return {
    element: root,
    search,
    session,
    update(next) {
      session.update(next);
      render();
    },
    render,
    apply,
    destroy() {
      unsubscribe();
      root.remove();
    },
  };
}
