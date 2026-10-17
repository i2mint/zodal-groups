/**
 * The tree's touch pass: what tapping a group does, the label seam, roving tabindex + APG tree
 * keys, and drag only under a fine pointer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, nodeId, type NodeId } from '@zodal/groups-core';
import { renderColumns, renderTree } from '../src/index.js';

/** `reading` under BOTH `research` and `leisure`; `paper.pdf` in `reading`; `note` in `leisure`. */
const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('paper.pdf', 'reading');
  g.add('reading', 'research');
  g.add('reading', 'leisure');
  g.add('note', 'leisure');
  return g;
};

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

/** Pretend to be a device: which media queries match. */
const stubMedia = (matching: readonly string[]) => {
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
};
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const row = (id: string) => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const key = (k: string) => {
  const el = document.activeElement as HTMLElement;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
};
const focusedId = () => (document.activeElement as HTMLElement).dataset.nodeId;

describe('groupActivate', () => {
  it("default 'toggle': tapping a group's name expands it, and selects nothing", () => {
    const selected: NodeId[] = [];
    renderTree(container, build(), { onSelect: (id) => selected.push(id) });
    row('leisure').querySelector<HTMLElement>('.zg-label')!.click();
    expect(row('leisure').getAttribute('aria-expanded')).toBe('true');
    expect(row('note')).toBeTruthy();
    expect(selected).toEqual([]);
    row('leisure').click(); // again: collapses
    expect(row('leisure').getAttribute('aria-expanded')).toBe('false');
  });

  it('a leaf is always selected', () => {
    const selected: NodeId[] = [];
    renderTree(container, build(), { onSelect: (id) => selected.push(id) });
    row('leisure').click();
    row('note').click();
    expect(selected).toEqual(['note']);
    expect(row('note').getAttribute('aria-selected')).toBe('true');
  });

  it("'select': tapping a group selects it; the twisty still expands", () => {
    const selected: NodeId[] = [];
    renderTree(container, build(), { groupActivate: 'select', onSelect: (id) => selected.push(id) });
    row('leisure').click();
    expect(selected).toEqual(['leisure']);
    expect(row('leisure').getAttribute('aria-expanded')).toBe('false');
    row('leisure').querySelector<HTMLElement>('.zg-twisty')!.click();
    expect(row('leisure').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the label seam', () => {
  it('subtitle: a title and a muted second line, both in the accessible name', () => {
    renderTree(container, build(), { subtitle: (r) => (r.nodeId === 'reading' ? '2 papers' : undefined) });
    row('research').click();
    const reading = row('reading');
    expect(reading.querySelector('.zg-label-title')!.textContent).toBe('reading');
    expect(reading.querySelector('.zg-label-subtitle')!.textContent).toBe('2 papers');
    expect(reading.getAttribute('aria-label')).toBe('reading, 2 papers, also in 1 other group');
    expect(row('research').querySelector('.zg-label-subtitle')).toBeNull(); // undefined: plain label
  });

  it('renderLabel: the host draws the label; the accessible name stays the model\'s', () => {
    renderTree(container, build(), {
      renderLabel: (r, el) => {
        const b = document.createElement('b');
        b.textContent = r.label.toUpperCase();
        el.appendChild(b);
      },
    });
    expect(row('research').querySelector('.zg-label b')!.textContent).toBe('RESEARCH');
    expect(row('research').getAttribute('aria-label')).toBe('research');
  });

  it('ariaLabel overrides the accessible name', () => {
    renderTree(container, build(), { ariaLabel: (r) => `Folder ${r.label}` });
    expect(row('research').getAttribute('aria-label')).toBe('Folder research');
  });
});

describe('keyboard: roving tabindex and APG tree keys', () => {
  it('exactly one tab stop, the first row when nothing is selected', () => {
    renderTree(container, build());
    const stops = rows().filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(rows()[0]);
  });

  it('the tab stop follows the selection', () => {
    renderTree(container, build());
    row('leisure').click();
    row('note').click();
    expect(rows().filter((r) => r.tabIndex === 0).map((r) => r.dataset.nodeId)).toEqual(['note']);
  });

  it('↓/↑ move, → expands then enters, ← goes to the parent then collapses, Home/End', () => {
    renderTree(container, build());
    rows()[0]!.focus();
    const first = focusedId();
    key('ArrowDown');
    expect(focusedId()).not.toBe(first);
    key('ArrowUp');
    expect(focusedId()).toBe(first);

    // `leisure` is first or second; go to it.
    while (focusedId() !== 'leisure') key('ArrowDown');
    key('ArrowRight'); // expand
    expect(row('leisure').getAttribute('aria-expanded')).toBe('true');
    expect(focusedId()).toBe('leisure'); // focus survives the re-render
    key('ArrowRight'); // into the first child
    expect(rows().indexOf(document.activeElement as HTMLElement)).toBe(rows().indexOf(row('leisure')) + 1);
    key('ArrowLeft'); // a leaf or a closed group: to the parent
    expect(focusedId()).toBe('leisure');
    key('ArrowLeft'); // an open group: collapse
    expect(row('leisure').getAttribute('aria-expanded')).toBe('false');

    key('End');
    expect(document.activeElement).toBe(rows().at(-1));
    key('Home');
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([document.activeElement]);
  });

  it('Enter and Space activate: a group toggles, a leaf is selected', () => {
    const selected: NodeId[] = [];
    renderTree(container, build(), { onSelect: (id) => selected.push(id) });
    row('leisure').focus();
    key('Enter');
    expect(row('leisure').getAttribute('aria-expanded')).toBe('true');
    row('note').focus();
    key(' ');
    expect(selected).toEqual(['note']);
    expect(document.activeElement).toBe(row('note'));
  });

  it('a handled key does not scroll the page', () => {
    renderTree(container, build());
    rows()[0]!.focus();
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('drag only under a fine pointer', () => {
  it('rows are draggable with a mouse', () => {
    stubMedia(['(pointer: fine)', '(hover: hover)']);
    renderTree(container, build());
    expect(rows().every((r) => r.draggable)).toBe(true);
  });

  it('rows are not draggable on touch (a long-press drag fights scrolling)', () => {
    stubMedia(['(pointer: coarse)']);
    renderTree(container, build());
    expect(rows().some((r) => r.draggable)).toBe(false);
  });

  it('the same for Miller columns', () => {
    stubMedia(['(pointer: coarse)']);
    renderColumns(container, build());
    expect([...container.querySelectorAll<HTMLElement>('.zg-column-row')].some((r) => r.draggable)).toBe(false);
  });

  it('draggable: false turns it off everywhere', () => {
    stubMedia(['(pointer: fine)']);
    renderTree(container, build(), { draggable: false });
    expect(rows().some((r) => r.draggable)).toBe(false);
  });

  it('no twin highlight without a hover (a tap would leave it stuck)', () => {
    stubMedia(['(pointer: coarse)']);
    const g = build();
    renderTree(container, g);
    for (const id of ['research', 'leisure']) row(id).querySelector<HTMLElement>('.zg-twisty')!.click();
    container.querySelector<HTMLElement>(`[data-node-id="${nodeId('reading')}"]`)!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(container.querySelectorAll('.is-twin').length).toBe(0);
  });
});

describe('host controls inside a label, and onToggle', () => {
  const withButton = () =>
    renderTree(container, build(), {
      renderLabel: (r, el) => {
        el.textContent = r.label;
        if (r.nodeId === 'leisure') {
          const b = document.createElement('button');
          b.textContent = 'edit';
          const i = document.createElement('input');
          el.append(b, i);
        }
      },
    });

  it('a click on a button in the label is the button\'s, not the row\'s', () => {
    withButton();
    row('leisure').querySelector('button')!.click();
    expect(row('leisure').getAttribute('aria-expanded')).toBe('false');
  });

  it('Space typed in an input in the label is not taken by the tree', () => {
    withButton();
    const field = row('leisure').querySelector('input')!;
    field.focus();
    const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    field.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(row('leisure').getAttribute('aria-expanded')).toBe('false');
  });

  it('onToggle reports what opened and closed', () => {
    const seen: Array<[string, boolean]> = [];
    renderTree(container, build(), { onToggle: (id, open) => seen.push([id, open]) });
    row('leisure').click();
    row('leisure').querySelector<HTMLElement>('.zg-twisty')!.click();
    expect(seen).toEqual([['leisure', true], ['leisure', false]]);
  });
});

