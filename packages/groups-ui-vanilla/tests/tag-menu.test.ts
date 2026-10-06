/**
 * The selection tagging menu in a real DOM: ARIA roles and states (tri-state as aria-checked),
 * keyboard navigation with focus kept in the search field, staged-until-applied, the live region,
 * inline violation messages, and the typed search text surviving everything.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXCLUSIVE, defineGroups, nodeId } from '@zodal/groups-core';
import { createVanillaRegistry, renderTagMenu } from '../src/index.js';

/** Gmail: `work` holds a, b, c; `urgent` holds a; `personal` holds d (outside the selection). */
const mail = () => {
  const g = defineGroups({ profile: 'labels' });
  for (const m of ['a', 'b', 'c']) g.add(m, 'work');
  g.add('a', 'urgent');
  g.add('d', 'personal');
  return g;
};

/** `status` is an exclusive family; `a` is in `todo`. */
const board = () => {
  const g = defineGroups({ profile: 'polyhierarchy', nodes: [{ id: nodeId('status'), label: 'Status', family: EXCLUSIVE }] });
  g.add('todo', 'status');
  g.add('doing', 'status');
  g.add('a', 'todo');
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
const activeOption = (input: HTMLInputElement) => document.getElementById(input.getAttribute('aria-activedescendant')!)!;
const applyButton = () => container.querySelector<HTMLButtonElement>('.zg-tagmenu-apply')!;
const live = () => container.querySelector<HTMLElement>('[role="status"]')!;

describe('ARIA roles and states', () => {
  it('is a combobox controlling a multiselectable listbox of tri-state options', () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    const input = menu.search;
    const list = container.querySelector<HTMLElement>('[role="listbox"]')!;

    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-label')).toBe('Search groups');
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(list.getAttribute('aria-label')).toBe('Groups for 3 selected items');

    expect(option('work').getAttribute('aria-checked')).toBe('true');
    expect(option('urgent').getAttribute('aria-checked')).toBe('mixed');
    expect(option('personal').getAttribute('aria-checked')).toBe('false');
    expect(option('urgent').getAttribute('aria-label')).toBe('urgent, 1 of 3');
  });

  it('gives every option a distinct DOM id, whatever characters its group id holds', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('a', 'with space');
    g.add('a', 'quote"and>');
    renderTagMenu(container, g, { selection: ['a'] });
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
    expect(options.every((o) => /^[\w-]+$/.test(o.id))).toBe(true);
  });

  it('a refused group stays reachable, aria-disabled, its reason as description and inline', () => {
    renderTagMenu(container, board(), { selection: ['a'] });
    const doing = option('doing');
    expect(doing.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(doing.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toContain('“Status” allows one value per item');
    expect(reason.textContent).toContain('Remove “a” from “todo” first.');
    expect(doing.contains(reason)).toBe(true); // shown inline, next to the option
  });
});

describe('keyboard: focus stays in the search field', () => {
  it('↓/↑ move aria-activedescendant; Enter toggles the active option', () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    const input = menu.search;
    expect(document.activeElement).toBe(input);

    // Rows are sorted: personal, urgent, work. The first is active.
    expect(activeOption(input).dataset.key).toBe('personal');
    key(input, 'ArrowDown');
    expect(activeOption(input).dataset.key).toBe('urgent');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown'); // clamps at the end, no wrap
    expect(activeOption(input).dataset.key).toBe('work');
    key(input, 'ArrowUp');
    expect(activeOption(input).dataset.key).toBe('urgent');

    key(input, 'Enter'); // mixed → all (Gmail)
    expect(option('urgent').getAttribute('aria-checked')).toBe('true');
    key(input, 'Enter'); // all → none
    expect(option('urgent').getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(input);
    expect(activeOption(input).dataset.key).toBe('urgent'); // the active option survives the re-render
  });

  it('Enter on a disabled option does nothing', () => {
    const g = board();
    const menu = renderTagMenu(container, g, { selection: ['a'] });
    while (activeOption(menu.search).dataset.key !== 'doing') key(menu.search, 'ArrowDown');
    key(menu.search, 'Enter');
    expect(option('doing').getAttribute('aria-checked')).toBe('false');
    expect(menu.session.view().plan.isEmpty).toBe(true);
  });

  it('a click toggles without taking focus from the search field', () => {
    const menu = renderTagMenu(container, mail(), { selection: ['a', 'b', 'c'] });
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option('personal').dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    option('personal').click();
    expect(option('personal').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(menu.search);
  });

  it('Escape asks the host to close and keeps the typed text', () => {
    const onClose = vi.fn();
    const menu = renderTagMenu(container, mail(), { selection: ['a'], onClose });
    type(menu.search, 'wor');
    key(menu.search, 'Escape');
    expect(onClose).toHaveBeenCalledOnce();
    expect(menu.search.value).toBe('wor');
  });
});

describe('staged until applied', () => {
  it('writes nothing until Apply; the button says how many items it will change', async () => {
    const g = mail();
    const menu = renderTagMenu(container, g, { selection: ['a', 'b', 'c'] });
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().textContent).toBe('Apply');

    option('urgent').click(); // b, c will be added
    expect(g.parents('b')).toEqual(['work']); // staged, not written
    expect(applyButton().disabled).toBe(false);
    expect(applyButton().textContent).toBe('Apply to 2 items');
    expect(container.querySelector('.zg-tagmenu-summary')!.textContent).toBe('Add “urgent” to 2 items');

    applyButton().click();
    await vi.waitFor(() => expect(live().textContent).toBe('Applied: tagged 2 items.'));
    expect(g.parents('b').sort()).toEqual(['urgent', 'work']);
    expect(option('urgent').getAttribute('aria-checked')).toBe('true'); // re-read from the model
    expect(applyButton().disabled).toBe(true);
    expect(document.activeElement).toBe(menu.search);
  });

  it('Ctrl/⌘+Enter applies', async () => {
    const g = mail();
    const menu = renderTagMenu(container, g, { selection: ['a', 'b'] });
    option('personal').click();
    key(menu.search, 'Enter', { ctrlKey: true });
    await vi.waitFor(() => expect(g.parents('a')).toContain('personal'));
  });

  it('hands the plan to onApply and announces what it reports, refusals included', async () => {
    const g = mail();
    const onApply = vi.fn(async () => ({
      succeeded: ['a'],
      failed: [{ id: 'b', reason: 'The provider rejected the write.' }],
    }));
    const menu = renderTagMenu(container, () => g.space, { selection: ['a', 'b'], onApply });
    option('personal').click();
    const text = await menu.apply();
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0]![0]).toMatchObject({ add: [{ group: 'personal', ids: ['a', 'b'] }] });
    expect(text).toBe('Applied: tagged 1 item, 1 refused: “b”: The provider rejected the write.');
    expect(live().textContent).toBe(text);
    expect(live().getAttribute('aria-live')).toBe('polite');
  });

  it('announces the items the plan left out as refused', async () => {
    const g = board();
    const menu = renderTagMenu(container, g, { selection: ['a', 'b'] });
    expect(option('doing').querySelector('.zg-tagmenu-reason')!.textContent).toContain('1 of 2 can’t take it');
    option('doing').click();
    const text = await menu.apply();
    expect(text).toMatch(/^Applied: tagged 1 item, 1 refused: “a”: “Status” allows one value per item/);
    expect(g.parents('b')).toEqual(['doing']);
    expect(g.parents('a')).toEqual(['todo']);
  });

  it('a write that throws keeps everything staged and says so', async () => {
    const g = mail();
    const menu = renderTagMenu(container, () => g.space, {
      selection: ['a'],
      onApply: () => {
        throw new Error('Network down');
      },
    });
    option('personal').click();
    const text = await menu.apply();
    expect(text).toBe('Could not apply: Network down. Your changes are still staged.');
    expect(option('personal').getAttribute('aria-checked')).toBe('true');
    expect(applyButton().disabled).toBe(false);
  });

  it('conflicting staged changes block Apply and say why', () => {
    renderTagMenu(container, board(), { selection: ['b'] });
    option('todo').click();
    option('doing').click();
    expect(applyButton().disabled).toBe(true);
    const conflicts = container.querySelector<HTMLElement>('.zg-tagmenu-conflicts')!;
    expect(conflicts.hidden).toBe(false);
    expect(conflicts.textContent).toContain('“Status” allows one value per item');
    expect(applyButton().getAttribute('aria-describedby')).toContain(conflicts.id);
  });

  it('Cancel drops the staged changes and closes', () => {
    const onClose = vi.fn();
    const menu = renderTagMenu(container, mail(), { selection: ['a'], onClose });
    option('personal').click();
    container.querySelector<HTMLButtonElement>('.zg-tagmenu-cancel')!.click();
    expect(menu.session.view().plan.isEmpty).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a bare GroupSpace without onApply fails at mount, not at Apply', () => {
    const g = mail();
    expect(() => renderTagMenu(container, g.space, { selection: ['a'] })).toThrow(/onApply/);
  });
});

describe('search and create', () => {
  it('filters as you type, and the typed text survives toggles, applies and updates', async () => {
    const g = mail();
    const menu = renderTagMenu(container, g, { selection: ['a', 'b'] });
    const input = menu.search;
    type(input, 'ur');
    const shown = [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
    expect(shown[0]).toContain('urgent');
    expect(shown.slice(1)).toEqual(['Create “ur”']); // not an exact name: creating it is offered, last

    key(input, 'Enter');
    await menu.apply();
    menu.update({ source: g });
    expect(menu.search).toBe(input); // the same element, never re-created
    expect(input.value).toBe('ur');
    expect(menu.session.view().query).toBe('ur');
  });

  it('says when nothing matches, and offers to create the typed group', () => {
    const g = mail();
    const menu = renderTagMenu(container, g, { selection: ['a', 'b'] });
    type(menu.search, 'Reading');
    const empty = container.querySelector<HTMLElement>('.zg-tagmenu-empty')!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe('No group matches “Reading”.');

    const create = container.querySelector<HTMLElement>('.zg-tagmenu-create')!;
    expect(create.textContent).toBe('Create “Reading”');
    expect(activeOption(menu.search)).toBe(create);
    key(menu.search, 'Enter');
    expect(option('Reading').getAttribute('aria-checked')).toBe('true');
    expect(option('Reading').classList.contains('is-new')).toBe(true);
    expect(applyButton().textContent).toBe('Apply to 2 items');
    expect(menu.search.value).toBe('Reading');
  });

  it('the create option explains a refusal', () => {
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { groupsMayContainItems: false } });
    const menu = renderTagMenu(container, g.space, { selection: ['a'], onApply: () => ({ succeeded: [], failed: [] }) });
    type(menu.search, 'new');
    const create = container.querySelector<HTMLElement>('.zg-tagmenu-create')!;
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(create.getAttribute('aria-describedby')!)!.textContent).toBe(
      'New groups can’t be created here.',
    );
  });
});

describe('registry', () => {
  it('resolves the tagMenu surface to the vanilla menu', () => {
    const registry = createVanillaRegistry();
    const renderer = registry.resolve({ surface: 'tagMenu', profile: mail().profile });
    expect(renderer).toBe(renderTagMenu);
  });
});
