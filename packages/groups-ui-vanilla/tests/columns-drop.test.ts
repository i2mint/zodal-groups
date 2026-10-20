/**
 * Miller columns: an ⌥ drop moves the edge on screen and keeps its kind (issue #25).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, edgesInto, nodeId } from '@zodal/groups-core';
import { renderColumns } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: fine)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const row = (id: string) => container.querySelector<HTMLElement>(`.zg-column-row[data-node-id="${id}"]`)!;
/** jsdom has no DragEvent: a plain Event with the fields the handlers read. */
const fire = (el: HTMLElement, type: string, altKey = false) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { altKey, dataTransfer: { setData() {} } });
  el.dispatchEvent(event);
};

describe('renderColumns drops', () => {
  it('an ⌥ drop moves the transitive edge on screen, keeping its kind and label', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    g.add('wheel', 'car', { kind: 'part_of', label: 'Front wheel' });
    g.add('wheel', 'car', { kind: 'instance_of' });
    g.add('frame', 'bike');
    renderColumns(container, g);
    row('car').click();

    fire(row('wheel'), 'dragstart');
    fire(row('bike'), 'drop', true);

    const edges = edgesInto(g.space, nodeId('wheel')).map((e) => `${e.parent}:${e.kind}:${e.label ?? ''}`).sort();
    expect(edges).toEqual(['bike:part_of:Front wheel', 'car:instance_of:']);
  });
});
