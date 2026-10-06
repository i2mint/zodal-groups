/**
 * From the PR #8 accessibility review of the tag menu: each test failed before its fix.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXCLUSIVE, defineGroups, nodeId } from '@zodal/groups-core';
import { renderTagMenu } from '../src/index.js';

const mail = () => {
  const g = defineGroups({ profile: 'labels' });
  for (const m of ['a', 'b', 'c']) g.add(m, 'work');
  g.add('a', 'urgent');
  g.add('d', 'personal');
  return g;
};
const board = () => {
  const g = defineGroups({ profile: 'polyhierarchy', nodes: [{ id: nodeId('status'), label: 'Status', family: EXCLUSIVE }] });
  g.add('todo', 'status');
  g.add('doing', 'status');
  g.add('x', 'doing');
  return g;
};

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const option = (group: string) => container.querySelector<HTMLElement>(`[role="option"][data-key="${group}"]`)!;
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const active = (input: HTMLInputElement) => input.getAttribute('aria-activedescendant');
const live = () => container.querySelector<HTMLElement>('[role="status"]')!;
const applyButton = () => container.querySelector<HTMLButtonElement>('.zg-tagmenu-apply')!;
/** Mutation records produced by `act`, flushed (MutationObserver delivers on a microtask). */
const mutations = async (target: Node, options: MutationObserverInit, act: () => void) => {
  const records: MutationRecord[] = [];
  const mo = new MutationObserver((r) => records.push(...r));
  mo.observe(target, options);
  act();
  await Promise.resolve();
  records.push(...mo.takeRecords());
  mo.disconnect();
  return records;
};

describe('A1 — options are updated in place, with ids keyed by group', () => {
  it('toggling keeps the option node and its id, and does not rewrite aria-activedescendant', async () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    key(menu.search, 'ArrowDown'); // personal → urgent
    const urgent = option('urgent');
    const id = urgent.id;
    expect(active(menu.search)).toBe(id);

    const records = await mutations(menu.search, { attributes: true, attributeFilter: ['aria-activedescendant'] }, () =>
      key(menu.search, 'Enter'),
    );
    expect(records).toHaveLength(0); // same target: no change event
    expect(option('urgent')).toBe(urgent);
    expect(urgent.id).toBe(id);
    expect(urgent.getAttribute('aria-checked')).toBe('true');
  });

  it('filtering moves aria-activedescendant to a different id when the active option changes', () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a'] });
    const personal = active(menu.search);
    type(menu.search, 'wor');
    expect(active(menu.search)).toBe(option('work').id);
    expect(active(menu.search)).not.toBe(personal);
    type(menu.search, '');
    expect(option('personal').id).toBe(personal); // the same group keeps its id
  });
});

describe('A7 — one render per input, rows updated in place', () => {
  it('a toggle adds or removes no option nodes and writes aria-checked once', async () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    const list = container.querySelector('[role="listbox"]')!;
    const records = await mutations(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-checked'] }, () =>
      option('personal').click(),
    );
    expect(records.filter((r) => r.type === 'childList' && r.target === list)).toHaveLength(0);
    expect(records.filter((r) => r.attributeName === 'aria-checked')).toHaveLength(1);
    expect(menu.session.view().plan.isEmpty).toBe(false);
  });

  it('an arrow key touches only the two options whose highlight changes', async () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a'] });
    const list = container.querySelector('[role="listbox"]')!;
    const records = await mutations(list, { subtree: true, attributes: true, childList: true }, () => key(menu.search, 'ArrowDown'));
    expect(records.filter((r) => r.type === 'childList')).toHaveLength(0);
    expect(new Set(records.map((r) => r.target)).size).toBe(2);
  });
});

describe('A2 — a re-sorted selection keeps what was staged', () => {
  it('keeps staged changes when the host re-sorts, and announces when a new selection drops them', async () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    option('personal').click();
    menu.update({ selection: ['c', 'b', 'a'] });
    expect(option('personal').getAttribute('aria-checked')).toBe('true');
    menu.update({ selection: ['d'] });
    await vi.waitFor(() => expect(live().textContent).toBe('The selection changed, so 1 staged change was discarded.'));
  });
});

describe('A3 — the outcome of a write in flight is never lost', () => {
  it('Escape and Cancel do not close while applying; destroy() still hands over the outcome', async () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    const onAnnounce = vi.fn();
    let finish!: (o: { succeeded: string[]; failed: never[] }) => void;
    const g = mail();
    const menu = renderTagMenu(container, () => g.space, {
      selection: ['a'],
      onClose,
      onChange,
      onAnnounce,
      onApply: () => new Promise((resolve) => (finish = resolve)),
    });
    option('personal').click();
    const pending = menu.apply();
    key(menu.search, 'Escape');
    container.querySelector<HTMLButtonElement>('.zg-tagmenu-cancel')!.click();
    expect(onClose).not.toHaveBeenCalled();
    expect(onAnnounce).toHaveBeenCalledWith('Still applying, please wait.');

    menu.destroy();
    onChange.mockClear();
    finish({ succeeded: ['a'], failed: [] });
    expect(await pending).toBe('Applied: tagged 1 item.');
    expect(onAnnounce).toHaveBeenLastCalledWith('Applied: tagged 1 item.');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('A4 — a disabled Apply explains itself', () => {
  it('stays focusable (aria-disabled), says why it cannot apply, and announces Applying…', async () => {
    let finish!: () => void;
    const g = mail();
    const menu = renderTagMenu(container, () => g.space, {
      selection: ['a'],
      onApply: () => new Promise((resolve) => (finish = () => resolve({ succeeded: ['a'], failed: [] }))),
    });
    expect(applyButton().hasAttribute('disabled')).toBe(false);
    expect(applyButton().getAttribute('aria-disabled')).toBe('true');
    applyButton().click();
    await vi.waitFor(() => expect(live().textContent).toBe('Nothing to apply yet: tick or untick a group first.'));

    option('personal').click();
    expect(applyButton().getAttribute('aria-disabled')).toBe('false');
    const done = menu.apply();
    await vi.waitFor(() => expect(live().textContent).toBe('Applying…'));
    expect(applyButton().getAttribute('aria-disabled')).toBe('true');
    finish();
    await done;
  });
});

describe('A5 — state in the name, valid ARIA on options', () => {
  it('never uses aria-checked="mixed" on an option; the name says how many and what is staged', () => {
    renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    const urgent = option('urgent');
    expect(urgent.getAttribute('aria-checked')).toBe('false');
    expect(urgent.getAttribute('aria-label')).toBe('urgent, on 1 of 3');
    urgent.click();
    expect(urgent.getAttribute('aria-checked')).toBe('true');
    expect(urgent.getAttribute('aria-label')).toBe('urgent, on 1 of 3, will add to 2');
  });
});

describe('A6 — a conflict is said once, politely', () => {
  it('is not an alert, is not repeated in the option description, and is announced once', () => {
    const onAnnounce = vi.fn();
    const menu = renderTagMenu(container, board(), { selection: ['b'], onAnnounce });
    option('todo').click();
    option('doing').click();
    const conflicts = container.querySelector<HTMLElement>('.zg-tagmenu-conflicts')!;
    expect(conflicts.getAttribute('role')).toBeNull();
    expect(conflicts.getAttribute('aria-live')).toBeNull();
    expect(conflicts.textContent).toContain('allows one value per item');
    const described = option('doing').getAttribute('aria-describedby');
    expect(described ? document.getElementById(described)!.textContent : '').not.toContain('allows one value per item');
    key(menu.search, 'ArrowDown');
    type(menu.search, 'do');
    expect(onAnnounce.mock.calls.filter(([t]) => String(t).includes('allows one value per item'))).toHaveLength(1);
  });
});

describe('A8 — contrast', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8'); // vitest runs in the package
  it('uses no fixed red that fails on a dark background, and keeps the active outline in forced colors', () => {
    expect(css).not.toMatch(/#c92a2a/i);
    expect(css).toMatch(/@media \(forced-colors: active\)[^}]*\.zg-tagmenu-option\.is-active/);
    expect(css).not.toMatch(/\.zg-tagmenu-option\.is-active\s*\{[^}]*currentColor 30%/);
  });
});

describe('nits', () => {
  it('PageDown and PageUp move by ten', () => {
    const g = defineGroups({ profile: 'labels' });
    for (let k = 10; k < 25; k++) g.add('z', `g${k}`);
    const menu = renderTagMenu(container, g, { selection: ['a'] });
    key(menu.search, 'PageDown');
    expect(active(menu.search)).toBe(option('g20').id);
    key(menu.search, 'PageDown');
    expect(active(menu.search)).toBe(option('g24').id); // clamps
    key(menu.search, 'PageUp');
    expect(active(menu.search)).toBe(option('g14').id);
  });

  it('Escape does not bubble to the host; without onClose it clears the field', () => {
    const outer = vi.fn();
    container.addEventListener('keydown', outer);
    const menu = renderTagMenu(container, mail(), { selection: ['a'] });
    type(menu.search, 'wo');
    key(menu.search, 'Escape');
    expect(outer).not.toHaveBeenCalled();
    expect(menu.search.value).toBe('');
    expect(menu.session.view().query).toBe('');
  });

  it('Escape and Cancel agree: both discard what was staged, say so, and close', async () => {
    for (const close of ['escape', 'cancel'] as const) {
      document.body.innerHTML = '';
      container = document.createElement('div');
      document.body.appendChild(container);
      const onClose = vi.fn();
      const menu = renderTagMenu(container, mail(), { selection: ['a'], onClose });
      option('personal').click();
      if (close === 'escape') key(menu.search, 'Escape');
      else container.querySelector<HTMLButtonElement>('.zg-tagmenu-cancel')!.click();
      expect(onClose).toHaveBeenCalledOnce();
      expect(menu.session.view().plan.isEmpty).toBe(true);
      await vi.waitFor(() => expect(live().textContent).toBe('Discarded 1 staged change.'));
    }
  });

  it('the create option is named by its text only; a refusal is its description', () => {
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { groupsMayContainItems: false } });
    const menu = renderTagMenu(container, g.space, { selection: ['a'], onApply: () => ({ succeeded: [], failed: [] }) });
    type(menu.search, 'new');
    const create = container.querySelector<HTMLElement>('.zg-tagmenu-create')!;
    expect(create.getAttribute('aria-label')).toBe('Create “new”');
    expect(document.getElementById(create.getAttribute('aria-describedby')!)!.textContent).toBe('New groups can’t be created here.');
  });

  it('the menu and its listbox do not carry the same name', () => {
    renderTagMenu(container, mail(), { selection: ['a'] });
    const list = container.querySelector('[role="listbox"]')!;
    const root = container.querySelector('.zg-tagmenu')!;
    expect(root.getAttribute('aria-label')).not.toBe(list.getAttribute('aria-label'));
  });

  it('hovering an option makes it the active one: one highlight at a time', () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a'] });
    option('work').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(active(menu.search)).toBe(option('work').id);
    expect(container.querySelectorAll('.is-active')).toHaveLength(1);
  });
});
