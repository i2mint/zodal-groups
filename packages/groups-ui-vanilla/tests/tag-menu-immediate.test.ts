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

  it('a failed write is not left staged: the next click does not resend it', async () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('a', 'work');
    g.add('b', 'urgent');
    g.add('c', 'later');
    let fail = true;
    const sent: unknown[] = [];
    const onApply = vi.fn((plan: { add: unknown[]; remove: unknown[] }) => {
      sent.push(plan);
      if (fail) throw new Error('offline');
      return { succeeded: ['a'], failed: [] };
    });
    const menu = renderTagMenu(container, g, { selection: ['a'], commit: 'immediate', onApply: onApply as never, onError: () => {} });
    option('urgent').click();
    await flush();
    expect(menu.session.state.pending.size).toBe(0);
    fail = false;
    option('later').click();
    await flush();
    expect(sent[1]).toMatchObject({ add: [{ group: 'later', ids: ['a'] }], remove: [] });
    expect((sent[1] as { add: unknown[] }).add).toHaveLength(1);
  });

  it('clicks during a write wait their turn, each its own write', async () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('a', 'work');
    g.add('b', 'urgent');
    let release!: () => void;
    const calls: string[] = [];
    const onApply = vi.fn(async (plan: { add: { group: string }[]; remove: { group: string }[] }) => {
      calls.push([...plan.add.map((c) => `+${c.group}`), ...plan.remove.map((c) => `-${c.group}`)].join(','));
      if (calls.length === 1) await new Promise<void>((done) => (release = done));
      return { succeeded: ['a'], failed: [] };
    });
    renderTagMenu(container, g, { selection: ['a'], commit: 'immediate', onApply: onApply as never });
    option('urgent').click();
    await flush();
    option('work').click(); // while the first write is in flight
    await flush();
    expect(calls).toEqual(['+urgent']);
    release();
    await flush();
    await flush();
    expect(calls).toEqual(['+urgent', '-work']);
  });

  it('Enter writes the active option; Ctrl+Enter does nothing (there is no Apply)', async () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('a', 'work');
    g.add('b', 'urgent');
    const onApply = vi.fn(() => ({ succeeded: ['a'], failed: [] }));
    const menu = renderTagMenu(container, g, { selection: ['a'], commit: 'immediate', onApply });
    menu.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    menu.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    menu.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
