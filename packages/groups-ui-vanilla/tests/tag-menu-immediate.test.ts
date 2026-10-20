/**
 * The tag menu's follow-ups (issue #9): "N through a subgroup" on a row, and commit: 'immediate'
 * (each click written at once, its own undo step, no Apply button).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineGroups, EXCLUSIVE, nodeId } from '@zodal/groups-core';
import { renderTagMenu } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const option = (group: string) => container.querySelector<HTMLElement>(`[role="option"][data-key="${group}"]`)!;
const flush = () => new Promise((done) => setTimeout(done, 0));

describe('tag menu: inherited', () => {
  it('shows how many of the selection are in a group through a subgroup', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('dog', 'animal');
    g.add('rex', 'dog');
    renderTagMenu(container, g, { selection: ['rex'] });
    const note = option('animal').querySelector<HTMLElement>('.zg-tagmenu-inherited')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('1 through a subgroup');
    expect(option('dog').querySelector<HTMLElement>('.zg-tagmenu-inherited')!.hidden).toBe(true);
  });
});

describe("tag menu: commit: 'immediate'", () => {
  it('writes each click at once, each its own undo step, with no Apply button', async () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('a', 'work');
    g.add('b', 'urgent');
    renderTagMenu(container, g, { selection: ['a'], commit: 'immediate' });
    expect(container.querySelector<HTMLButtonElement>('.zg-tagmenu-apply')!.hidden).toBe(true);

    option('urgent').click();
    await flush();
    expect(g.parents('a').sort()).toEqual(['urgent', 'work']);
    option('work').click();
    await flush();
    expect(g.parents('a')).toEqual(['urgent']);

    expect(g.undo()).toBe(true);
    expect(g.parents('a').sort()).toEqual(['urgent', 'work']);
    expect(g.undo()).toBe(true);
    expect(g.parents('a')).toEqual(['work']);
  });

  it('calls onApply once per click', async () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('a', 'work');
    g.add('b', 'urgent');
    const onApply = vi.fn(() => ({ succeeded: ['a'], failed: [] }));
    renderTagMenu(container, g, { selection: ['a'], commit: 'immediate', onApply });
    option('urgent').click();
    await flush();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toMatchObject({ add: [{ group: 'urgent', ids: ['a'] }] });
  });

  it('a click that cannot be written is said and not left staged', async () => {
    const g = defineGroups({ profile: 'polyhierarchy', nodes: [{ id: nodeId('status'), family: EXCLUSIVE }] });
    g.add('todo', 'status');
    g.add('doing', 'status');
    g.add('a', 'todo');
    g.add('x', 'doing');
    const menu = renderTagMenu(container, g, { selection: ['a'], commit: 'immediate' });
    option('doing').click(); // Status allows one value per item: refused in the dry run
    await flush();
    expect(menu.session.state.pending.size).toBe(0);
    expect(g.parents('a')).toEqual(['todo']);
  });
});
