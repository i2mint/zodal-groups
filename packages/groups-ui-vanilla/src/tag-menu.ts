/**
 * A vanilla selection-tagging menu — Gmail's label menu over a selection, staged until "Apply".
 *
 * Everything it shows comes from `@zodal/groups-ui`'s tagging session: each group's state over the
 * selection, the click cycle, why a group would be refused, the staged-changes summary and the plan.
 * This file only draws it and forwards keys and clicks.
 *
 * The ARIA shape is the APG combobox with a listbox popup (GitHub Primer's SelectPanel is the same
 * shape): **focus stays in the search field** and `aria-activedescendant` points at the active
 * option, so typing always filters, arrows always move, and nothing the user typed is ever lost —
 * the field is created once and never re-rendered. How state changes reach a screen reader is the
 * part that is easy to get wrong, and it shapes the code:
 *
 * - **Options are updated in place.** Each group's `<li>` is created once and keeps an id derived
 *   from the group (not from its position), and `aria-activedescendant` is written only when the
 *   active group changes. Rebuilding the list on each render would point the same id at a new node,
 *   which fires no event: a toggle or a filter would go unannounced.
 * - **The state is in the name.** `aria-checked="mixed"` is defined for checkboxes, not options, so
 *   an option is `aria-checked` true (on all) or false, and its name says the rest: *"urgent, on 1
 *   of 3, will add to 2"*.
 * - **One polite live region** says what no option shows: the Apply outcome, "Applying…", why Apply
 *   cannot run, a conflict (once), staged changes dropped by a new selection or discarded by Cancel.
 * - **A refused option stays reachable** (`aria-disabled`, not removed), its reason as description.
 * - **Apply is `aria-disabled`, never `disabled`**, so it stays focusable and can say why not.
 *
 * Keys, in the search field: ↓/↑ move the active option, PageDown/PageUp by ten; Enter toggles it
 * (or creates the typed group); Ctrl/⌘+Enter applies; Escape discards what was staged and asks the
 * host to close (`onClose`), like Cancel — or, without `onClose`, clears the field.
 *
 * Nothing is written until Apply. The write is the host's (`onApply` receives the plan — call
 * `collection.bulkTag` per batch, or apply `planToDelta` to a store); with a `Groups` handle as the
 * source it defaults to applying there. While a write is in flight the menu will not close, and if
 * the host destroys it anyway the outcome still reaches `onAnnounce` and the `apply()` promise.
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
  /** Escape or Cancel (after discarding what was staged): the host closes its popover. Not called while applying. */
  readonly onClose?: () => void;
  /** After every staged change (toggle, create, discard) and after an apply. Not called once destroyed. */
  readonly onChange?: (view: TaggingView) => void;
  /**
   * Every sentence the menu announces, as it announces it — for a host that keeps its own live
   * region. The only place the outcome of a write lands if the menu was destroyed meanwhile.
   */
  readonly onAnnounce?: (text: string) => void;
  /**
   * The error `onApply` threw — for the host's logs. The live region says only `applyFailed`, in
   * plain language: an error message can hold a path or an errno, which a screen reader would read.
   */
  readonly onError?: (error: unknown) => void;
  /** Focus the search field on mount. Default `true` (the menu was just opened). */
  readonly autoFocus?: boolean;
  /** The menu's accessible name. Default: none (the listbox is named); give one when the menu needs it. */
  readonly label?: string;
}

export interface TagMenuRenderer {
  readonly element: HTMLElement;
  /** The search field — the one element that holds focus. */
  readonly search: HTMLInputElement;
  readonly session: TaggingSession;
  /** The model or the selection changed (a different selection drops what was staged, and says so). */
  update(next: { readonly source?: SpaceSource; readonly selection?: Iterable<NodeId | string> }): void;
  render(): void;
  /** Apply what is staged, as the button does. Resolves with the announced sentence ('' when it could not start). */
  apply(): Promise<string>;
  destroy(): void;
}

const CREATE_KEY = '\u0000create';
const PAGE = 10;
/** Delay between clearing the live region and filling it, so a repeated sentence is read again. */
const ANNOUNCE_DELAY_MS = 50;
let instances = 0;

const isGroupsHandle = (x: unknown): x is Parameters<typeof applyTagging>[0] =>
  typeof x === 'object' && x !== null && 'space' in x && typeof (x as { apply?: unknown }).apply === 'function';

/** Write only when different: every write to an option or a live region can be announced. */
const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
const setAttr = (el: Element, name: string, value: string | null): void => {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};

/** One option's nodes, created once per group and updated in place. */
interface OptionNodes {
  readonly li: HTMLLIElement;
  readonly label: HTMLSpanElement;
  readonly path: HTMLSpanElement;
  readonly count: HTMLSpanElement;
  readonly reason: HTMLDivElement;
  /** What it was last drawn from: the session reuses unchanged rows, so identity means "nothing to do". */
  drawn?: unknown;
}

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
  const ids = { list: `${uid}-list`, summary: `${uid}-summary`, conflicts: `${uid}-conflicts` };

  let activeKey: string | null = null;
  let busy = false;
  let destroyed = false;
  let lastConflict = '';
  let lastNotice: string | undefined;

  // ── the skeleton: built once, so the search field (and its text, caret, focus) is never replaced ──
  const root = document.createElement('div');
  root.className = 'zg-tagmenu';
  if (options.label) {
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', options.label);
  }

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
  // Plain text, referenced by Apply's description. Not a live region: the status region below says
  // a conflict once, politely, when it appears.
  const conflicts = document.createElement('div');
  conflicts.className = 'zg-tagmenu-conflicts';
  conflicts.id = ids.conflicts;
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
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  root.append(search, list, empty, footer, live);
  container.appendChild(root);

  // ── options, created once per group and kept ──
  const nodes = new Map<string, OptionNodes>();
  const serial = new Map<string, number>();
  /** A DOM id per group, stable for the menu's life. Not the group id itself: that may hold any character. */
  const idFor = (key: string): string => {
    let n = serial.get(key);
    if (n === undefined) serial.set(key, (n = serial.size));
    return `${uid}-g${n}`;
  };

  const nodesFor = (key: string): OptionNodes => {
    let o = nodes.get(key);
    if (o) return o;
    const li = document.createElement('li');
    li.id = idFor(key);
    li.className = 'zg-tagmenu-option';
    li.dataset.key = key;
    li.setAttribute('role', 'option');
    const box = document.createElement('span');
    box.className = 'zg-tagmenu-box';
    box.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'zg-tagmenu-text';
    const label = document.createElement('span');
    label.className = 'zg-tagmenu-label';
    const path = document.createElement('span');
    path.className = 'zg-tagmenu-path';
    text.append(label, path);
    const count = document.createElement('span');
    count.className = 'zg-tagmenu-count';
    count.setAttribute('aria-hidden', 'true'); // already in the accessible name
    const reason = document.createElement('div');
    reason.className = 'zg-tagmenu-reason';
    reason.id = `${li.id}-reason`;
    li.append(box, text, count, reason);
    o = { li, label, path, count, reason };
    nodes.set(key, o);
    return o;
  };

  const describe = (o: OptionNodes, description: string | undefined): void => {
    setText(o.reason, description ?? '');
    o.reason.hidden = !description;
    setAttr(o.li, 'aria-describedby', description ? o.reason.id : null);
  };

  const drawRow = (o: OptionNodes, row: TagRow, t: TaggingView['messages']['tagging']): void => {
    if (o.drawn === row) return; // the session reuses an unchanged row: nothing to write
    o.drawn = row;
    const { li } = o;
    setAttr(li, 'aria-checked', row.state === 'all' ? 'true' : 'false');
    setAttr(li, 'aria-label', row.aria.label);
    setAttr(li, 'aria-disabled', row.aria.disabled ? 'true' : null);
    setAttr(li, 'data-state', row.state);
    li.classList.toggle('is-pending', row.pending);
    li.classList.toggle('is-new', row.isNew);
    li.classList.toggle('is-disabled', row.disabled);
    setText(o.label, row.label);
    setText(o.path, row.path ?? '');
    o.path.hidden = !row.path;
    setText(o.count, row.originalState === 'some' ? t.countOf(row.count, row.total) : '');
    describe(o, row.aria.description);
  };

  const drawCreate = (o: OptionNodes, create: NonNullable<TaggingView['create']>): void => {
    if (o.drawn === create) return;
    o.drawn = create;
    o.li.classList.add('zg-tagmenu-create');
    setAttr(o.li, 'aria-checked', 'false');
    setAttr(o.li, 'aria-label', create.text); // named by its text only; a refusal is its description
    setAttr(o.li, 'aria-disabled', create.allowed ? null : 'true');
    o.li.classList.toggle('is-disabled', !create.allowed);
    setText(o.label, create.text);
    describe(o, create.allowed ? undefined : create.reason);
  };

  // ── the active option ──
  let visibleKeys: string[] = [];
  let activeLi: HTMLLIElement | null = null;

  /** Move the highlight and `aria-activedescendant` — only what changes, so nothing is re-announced. */
  const setActive = (key: string | null): void => {
    activeKey = key;
    const li = key ? (nodes.get(key)?.li ?? null) : null;
    if (li === activeLi) return;
    activeLi?.classList.remove('is-active');
    li?.classList.add('is-active');
    activeLi = li;
    setAttr(search, 'aria-activedescendant', li ? li.id : null);
    li?.scrollIntoView?.({ block: 'nearest' });
  };

  // ── announcing ──
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const announce = (text: string): void => {
    if (!text) return;
    options.onAnnounce?.(text);
    if (destroyed) return;
    // Clear, then fill after a beat: the same sentence twice in a row is still read.
    live.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      if (!destroyed) live.textContent = text;
    }, ANNOUNCE_DELAY_MS);
  };

  // ── render: once per input; options in place ──
  const render = (): void => {
    if (destroyed) return;
    const view = session.view();
    const t = view.messages.tagging;

    setAttr(search, 'aria-label', t.searchLabel);
    if (search.placeholder !== t.searchPlaceholder(options.allowCreate !== false)) {
      search.placeholder = t.searchPlaceholder(options.allowCreate !== false);
    }
    setAttr(list, 'aria-label', t.listLabel(view.selection.length));
    setAttr(root, 'aria-busy', String(busy));

    const shown: HTMLLIElement[] = [];
    const keys: string[] = [];
    for (const row of view.rows) {
      const o = nodesFor(row.group);
      drawRow(o, row, t);
      shown.push(o.li);
      keys.push(row.group);
    }
    if (view.create) {
      const o = nodesFor(CREATE_KEY);
      drawCreate(o, view.create);
      shown.push(o.li);
      keys.push(CREATE_KEY);
    }
    // Reorder and prune with the fewest DOM moves: an option that is already in place is not touched.
    let cursor = list.firstChild;
    for (const li of shown) {
      if (cursor === li) cursor = cursor.nextSibling;
      else list.insertBefore(li, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      list.removeChild(cursor);
      cursor = next;
    }
    visibleKeys = keys;

    // The active option follows the model (a group id), so it survives filtering and re-renders.
    setActive(activeKey && visibleKeys.includes(activeKey) ? activeKey : (visibleKeys[0] ?? null));

    setText(empty, view.empty ?? '');
    empty.hidden = !view.empty;

    const lines = view.summary.join('\n');
    if (summary.dataset.lines !== lines) {
      summary.dataset.lines = lines;
      summary.replaceChildren(
        ...view.summary.map((line) => {
          const li = document.createElement('li');
          li.textContent = line;
          return li;
        }),
      );
    }
    const conflictText = view.plan.conflicts.map((c) => (c.fix ? `${c.message} ${c.fix}` : c.message)).join(' ');
    setText(conflicts, conflictText);
    conflicts.hidden = !conflictText;

    setText(applyButton, busy ? t.applying : view.applyLabel);
    setAttr(applyButton, 'aria-disabled', String(busy || !view.canApply));
    setText(cancelButton, t.cancelButton);

    // Say once what appeared: a conflict, a notice from the session.
    if (conflictText && conflictText !== lastConflict) announce(conflictText);
    lastConflict = conflictText;
    if (view.notice && view.notice !== lastNotice) announce(view.notice);
    lastNotice = view.notice;
  };

  const changed = (): void => {
    if (!destroyed) options.onChange?.(session.view());
  };

  /** Toggle a group, or create the typed one. The session's notification renders. */
  const activate = (key: string): void => {
    if (busy) return announce(session.view().messages.tagging.stillApplying);
    if (key === CREATE_KEY) {
      const create = session.view().create;
      if (!create?.allowed) return;
      activeKey = create.group;
      session.create();
    } else {
      setActive(key);
      session.toggle(key);
    }
    changed();
  };

  const move = (step: number): void => {
    if (!visibleKeys.length) return;
    const at = activeKey ? visibleKeys.indexOf(activeKey) : -1;
    setActive(visibleKeys[Math.min(visibleKeys.length - 1, Math.max(0, at + step))]!);
  };

  /** Escape and Cancel: discard what was staged (and say so), then let the host close. */
  const cancel = (): void => {
    const t = session.view().messages.tagging;
    if (busy) return announce(t.stillApplying);
    const staged = session.state.pending.size;
    if (staged) {
      session.reset();
      announce(t.discarded(staged));
      changed();
    }
    options.onClose?.();
  };

  const apply = async (): Promise<string> => {
    const t = session.view().messages.tagging;
    if (busy) {
      announce(t.stillApplying);
      return '';
    }
    const view = session.view();
    if (!view.canApply) {
      announce(view.blocked ?? t.nothingToApply);
      return '';
    }
    busy = true;
    render();
    announce(t.applying);
    const plan = session.apply();
    let text: string;
    try {
      const outcome = await onApply(plan);
      busy = false;
      text = session.complete(outcome);
    } catch (error) {
      busy = false;
      text = t.applyFailed;
      options.onError?.(error);
    }
    announce(text);
    if (destroyed) return text;
    render();
    changed();
    if (!root.contains(document.activeElement)) search.focus();
    return text;
  };

  // ── events ──
  search.addEventListener('input', () => {
    session.setQuery(search.value);
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
      case 'PageDown':
        e.preventDefault();
        move(PAGE);
        break;
      case 'PageUp':
        e.preventDefault();
        move(-PAGE);
        break;
      case 'Enter':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) void apply();
        else if (activeKey) activate(activeKey);
        break;
      case 'Escape':
        // The menu handles it: a host listening above must not close a second time.
        e.preventDefault();
        e.stopPropagation();
        if (options.onClose) cancel();
        else if (search.value) {
          search.value = ''; // APG: Escape clears an editable combobox it cannot close
          session.setQuery('');
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
  // The pointer moves the same highlight the keys do: never two "active" rows at once.
  list.addEventListener('mousemove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('[role="option"]');
    if (li?.dataset.key && li.dataset.key !== activeKey) setActive(li.dataset.key);
  });

  applyButton.addEventListener('click', () => void apply());
  cancelButton.addEventListener('click', cancel);

  const unsubscribe = session.subscribe(render);
  render();
  if (options.autoFocus !== false) search.focus();

  return {
    element: root,
    search,
    session,
    update(next) {
      session.update(next); // notifies: renders, and announces a notice if staged changes were dropped
    },
    render,
    apply,
    destroy() {
      destroyed = true;
      clearTimeout(announceTimer);
      unsubscribe();
      root.remove();
    },
  };
}
