/**
 * `renderTagInput` never creates a group by accident: Enter picks the group the text names (case
 * insensitively) or the only one it is a prefix of; creating is the explicit "Create" option. And
 * the field is built once: typed text and focus survive redraws (#19), and a rollback leaves no
 * stray undo entry (#19) nor reports a rollback the host already did as refused (#17).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, nodeId } from '@zodal/groups-core';
import { renderTagInput } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

/** Groups: Campfire, Camping, To learn (each has a member, so each is a group). */
const build = () => {
  const g = defineGroups({ profile: 'labels' });
  g.add('song-9', 'Campfire');
  g.add('song-9', 'Camping');
  g.add('song-8', 'To learn');
  g.add('song-1', 'To learn');
  return g;
};

const input = () => container.querySelector<HTMLInputElement>('.zg-tag-input')!;
const typeText = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event('input'));
};
const press = (key: string) => {
  const e = new KeyboardEvent('keydown', { key, cancelable: true });
  input().dispatchEvent(e);
  return e;
};
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const status = () => container.querySelector('[role="status"]')!.textContent;
const mount = (g = build(), opts = {}) => {
  const r = renderTagInput(container, g, opts);
  r.show(nodeId('song-1'));
  input().focus();
  return r;
};

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Enter picks an existing group, never creates one', () => {
  it('a case-insensitive exact name picks that group', () => {
    const g = build();
    const nodes = g.space.nodes.size;
    mount(g);
    typeText('campfire');
    press('Enter');
    expect(g.parents('song-1').sort()).toEqual(['Campfire', 'To learn']);
    expect(g.space.nodes.size).toBe(nodes); // no "campfire" node
    expect(input().value).toBe('');
  });

  it('a unique prefix picks that group (the typo case: "Campf")', () => {
    const g = build();
    mount(g);
    typeText('Campf');
    press('Enter');
    expect(g.parents('song-1')).toContain('Campfire');
    expect(g.space.nodes.has(nodeId('Campf'))).toBe(false);
  });

  it('an ambiguous prefix picks nothing and says so', () => {
    const g = build();
    mount(g);
    typeText('camp');
    press('Enter');
    expect(g.parents('song-1')).toEqual(['To learn']);
    expect(status()).toContain('2 groups start with “camp”');
    expect(input().value).toBe('camp'); // kept, to refine
  });

  it('no match: nothing is created, the reason is announced, and Create is offered', () => {
    const g = build();
    mount(g);
    typeText('Campfre');
    press('Enter');
    expect(g.space.nodes.has(nodeId('Campfre'))).toBe(false);
    expect(status()).toContain('No group is called “Campfre”');
    const create = container.querySelector<HTMLElement>('.zg-tag-create')!;
    expect(create.textContent).toBe('Create “Campfre”');
    expect(create.classList.contains('is-active')).toBe(false); // never preselected
  });

  it('creating is explicit: tap Create, or arrow to it and press Enter', () => {
    const g = build();
    mount(g);
    typeText('Slow ones');
    container.querySelector<HTMLElement>('.zg-tag-create')!.click();
    expect(g.parents('song-1')).toContain('Slow ones');

    typeText('Fast ones');
    press('ArrowDown'); // the only option: Create
    press('Enter');
    expect(g.parents('song-1')).toContain('Fast ones');
    expect(document.activeElement).toBe(input());
  });

  it('a group the item is already in is not offered; Enter says so', () => {
    const g = build();
    mount(g);
    typeText('to learn');
    expect(options().map((o) => o.textContent)).not.toContain('To learn');
    press('Enter');
    expect(status()).toBe('Already in “To learn”.');
    expect(input().value).toBe('');
  });

  it('no Create option when the text names a group exactly', () => {
    mount();
    typeText('Camping');
    expect(container.querySelector('.zg-tag-create')).toBeNull();
  });

  it('labels can be replaced', () => {
    mount(build(), { labels: { create: (t: string) => `Nouveau « ${t} »` } });
    typeText('zz');
    expect(container.querySelector('.zg-tag-create')!.textContent).toBe('Nouveau « zz »');
  });
});

describe('the combobox', () => {
  it('APG roles; the list opens as you type; the highlight is aria-activedescendant', () => {
    mount();
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    typeText('camp');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(options().map((o) => o.firstChild!.textContent)).toEqual(['Campfire', 'Camping', 'Create “camp”']);
    expect(input().hasAttribute('aria-activedescendant')).toBe(false); // ambiguous: nothing preselected
    press('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    press('ArrowUp'); // wraps
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
  });

  it('option ids change when the list does, so a new list is announced', () => {
    mount();
    typeText('camp');
    const before = options().map((o) => o.id);
    typeText('campi');
    expect(options().map((o) => o.id).some((id) => before.includes(id))).toBe(false);
  });

  it('Escape closes the list, then clears the field', () => {
    mount();
    typeText('camp');
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().value).toBe('camp');
    press('Escape');
    expect(input().value).toBe('');
  });

  it('a mouse press on an option keeps focus in the field', () => {
    mount();
    typeText('Campf');
    const e = new MouseEvent('mousedown', { cancelable: true });
    options()[0]!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('redraws and rollbacks (#19, #17)', () => {
  it('a rejected write keeps what you are typing, and focus (#19)', async () => {
    const g = build();
    const server = deferred();
    mount(g, { onWrite: () => server.promise });
    typeText('Campfire');
    press('Enter');
    typeText('Cam'); // typing the next one while the first is saving
    server.reject(new Error('503'));
    await flush();
    expect(g.parents('song-1')).toEqual(['To learn']); // rolled back...
    expect(input().value).toBe('Cam'); // ...and the typed text survived
    expect(document.activeElement).toBe(input());
  });

  it('removing a chip keeps focus in the widget', () => {
    const g = build();
    mount(g);
    const remove = container.querySelector<HTMLElement>('.zg-chip-remove')!;
    remove.focus();
    remove.click();
    expect(document.activeElement).toBe(input());
  });

  it('the fallback rollback leaves no undo entry that would re-apply the rejected edit (#19)', async () => {
    const g = build();
    const server = deferred();
    mount(g, { onWrite: () => server.promise });
    typeText('Campfire');
    press('Enter');
    g.add('song-1', 'Camping'); // the host writes in between: the quick undo is not safe
    const depth = g.undoDepth;
    server.reject(new Error('conflict'));
    await flush();
    expect(g.parents('song-1').sort()).toEqual(['Camping', 'To learn']);
    expect(g.undoDepth).toBe(depth); // the rollback added nothing to the history
    g.undo(); // undoes the host's edit...
    expect(g.parents('song-1')).not.toContain('Campfire'); // ...and does not resurrect the rejected one
  });

  it('a rollback the host already did is a success, not "could not be undone" (#17)', async () => {
    const g = build();
    const server = deferred();
    const errors: Array<{ rolledBack: boolean }> = [];
    mount(g, { onWrite: () => server.promise, onError: (_e: unknown, ctx: { rolledBack: boolean }) => errors.push(ctx) });
    container.querySelector<HTMLElement>('.zg-chip-remove')!.click(); // remove "To learn"
    expect(g.parents('song-1')).toEqual([]);
    g.undo(); // the host undoes the removal itself, while it is in flight
    expect(g.parents('song-1')).toEqual(['To learn']);
    server.reject(new Error('offline'));
    await flush();
    expect(g.parents('song-1')).toEqual(['To learn']);
    expect(errors).toEqual([expect.objectContaining({ rolledBack: true })]);
    expect(status()).not.toContain('could not be undone');
  });

  it('a host listener writing during the rollback keeps its own undo entry on top', async () => {
    const g = build();
    const server = deferred();
    mount(g, { onWrite: () => server.promise });
    typeText('Campfire');
    press('Enter');
    g.add('song-1', 'Camping'); // forces the fallback rollback
    let logged = false;
    g.subscribe((change) => {
      if (!logged && change.delta.removed?.length) {
        logged = true;
        g.add('song-7', 'log'); // writes inside the rollback's notification
      }
    });
    server.reject(new Error('conflict'));
    await flush();
    expect(g.parents('song-1')).not.toContain('Campfire');
    expect(g.parents('song-7')).toEqual(['log']);
    g.undo(); // the top entry is still the host's
    expect(g.parents('song-7')).toEqual([]);
  });

  it('rolling back a Create that another item has joined since keeps the group, drops only ours', async () => {
    const g = build();
    const server = deferred();
    const errors: Array<{ rolledBack: boolean }> = [];
    mount(g, { onWrite: () => server.promise, onError: (_e: unknown, ctx: { rolledBack: boolean }) => errors.push(ctx) });
    typeText('Urgent');
    container.querySelector<HTMLElement>('.zg-tag-create')!.click();
    g.add('song-8', 'Urgent'); // someone else joins the new group
    server.reject(new Error('503'));
    await flush();
    expect(g.parents('song-1')).not.toContain('Urgent');
    expect(g.parents('song-8')).toContain('Urgent');
    expect(errors).toEqual([expect.objectContaining({ rolledBack: true })]);
  });
});

describe('picking details', () => {
  it('Enter during IME composition picks nothing', () => {
    const g = build();
    mount(g);
    typeText('Campf');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(g.parents('song-1')).toEqual(['To learn']);
  });

  it('a prefix is unique among the groups it can still join', () => {
    const g = build();
    g.add('song-1', 'Campfire');
    mount(g);
    typeText('Cam'); // Campfire (already in) and Camping: only Camping can be picked
    press('Enter');
    expect(g.parents('song-1')).toContain('Camping');
  });
});

