/**
 * The tree's drop handlers forward `dropOptions` to `resolveDrop` (issue #18): a Finder-style
 * host gets a plain drop as a move under a single-parent profile, and an ⌥ drop moves by default.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups } from '@zodal/groups-core';
import { renderTree } from '../src/index.js';

const build = () => {
  const g = defineGroups({ profile: 'filesystem' });
  g.add('report', 'documents');
  g.add('x', 'archive');
  return g;
};

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const rowOf = (id: string) => container.querySelector<HTMLElement>(`[role="treeitem"][data-node-id="${id}"]`)!;

/** jsdom has no DragEvent: a plain Event with the fields the handlers read. */
const fire = (el: HTMLElement, type: string, altKey = false) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { altKey, dataTransfer: { setData() {} } });
  el.dispatchEvent(event);
  return event;
};

describe('renderTree drops', () => {
  it('an ⌥ drop moves under a single-parent profile', () => {
    const g = build();
    renderTree(container, g);
    rowOf('documents').click();
    fire(rowOf('report'), 'dragstart');
    fire(rowOf('archive'), 'drop', true);
    expect(g.parents('report')).toEqual(['archive']);
  });

  it('a plain drop is refused by default and says how to move', () => {
    const g = build();
    renderTree(container, g);
    rowOf('documents').click();
    fire(rowOf('report'), 'dragstart');
    const over = fire(rowOf('archive'), 'dragover');
    expect(over.defaultPrevented).toBe(false);
    expect(rowOf('archive').title).toMatch(/Alt/);
    fire(rowOf('archive'), 'drop');
    expect(g.parents('report')).toEqual(['documents']);
  });

  it("dropOptions.singleParentDrop: 'move' makes a plain drop a move", () => {
    const g = build();
    renderTree(container, g, { dropOptions: { singleParentDrop: 'move' } });
    rowOf('documents').click();
    fire(rowOf('report'), 'dragstart');
    expect(fire(rowOf('archive'), 'dragover').defaultPrevented).toBe(true);
    expect(rowOf('archive').classList.contains('is-drop-move')).toBe(true);
    fire(rowOf('archive'), 'drop');
    expect(g.parents('report')).toEqual(['archive']);
  });
});
