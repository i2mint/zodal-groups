/**
 * End-to-end: does the whole stack actually render, in a real DOM?
 *
 * These assert the things the research says renderers get wrong — DOM keys, ARIA under
 * multi-parenthood, and the twin cross-highlight — rather than just "it didn't throw".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, nodeId } from '@zodal/groups-core';
import { renderTree, renderColumns, renderTagInput, renderBreadcrumbs } from '../src/index.js';

/** A polyhierarchy: `reading` lives under BOTH `research` and `leisure`. */
const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('paper.pdf', 'reading');
  g.add('reading', 'research');
  g.add('reading', 'leisure');
  return g;
};

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('vanilla tree', () => {
  it('renders a tree with correct ARIA roles', () => {
    const tree = renderTree(container, build());
    expect(tree.element.getAttribute('role')).toBe('tree');
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0);
  });

  it('keys DOM elements by PATH, so the same node twice is still valid HTML', () => {
    const g = build();
    renderTree(container, g);
    // Expand both roots to surface `reading` twice.
    for (const twisty of container.querySelectorAll<HTMLElement>('.zg-twisty')) twisty.click();

    const readingRows = container.querySelectorAll<HTMLElement>('[data-node-id="reading"]');
    expect(readingRows.length).toBe(2); // it genuinely appears under both parents

    const keys = [...readingRows].map((el) => el.dataset.key);
    expect(new Set(keys).size).toBe(2); // ...with DISTINCT DOM keys. No duplicate ids.
  });

  it('announces multi-parenthood in the accessible name, since ARIA cannot express it structurally', () => {
    const g = build();
    renderTree(container, g);
    for (const twisty of container.querySelectorAll<HTMLElement>('.zg-twisty')) twisty.click();

    const reading = container.querySelector<HTMLElement>('[data-node-id="reading"]')!;
    expect(reading.getAttribute('aria-label')).toContain('also in 1 other group');
    expect(reading.getAttribute('aria-level')).toBe('2');
    expect(reading.getAttribute('aria-posinset')).toBeTruthy();
    expect(reading.getAttribute('aria-setsize')).toBeTruthy();
  });

  it('cross-highlights the twins on hover — "this is the same thing, over there"', () => {
    const g = build();
    renderTree(container, g);
    for (const twisty of container.querySelectorAll<HTMLElement>('.zg-twisty')) twisty.click();

    const [first] = container.querySelectorAll<HTMLElement>('[data-node-id="reading"]');
    first!.dispatchEvent(new MouseEvent('mouseenter'));

    expect(container.querySelectorAll('.is-twin').length).toBe(1);
  });

  it('expands one appearance without expanding the other (expansion is path-keyed)', () => {
    const g = build();
    renderTree(container, g);

    const twisties = container.querySelectorAll<HTMLElement>('.zg-twisty');
    twisties[0]!.click(); // open the first root only

    const readingRows = container.querySelectorAll('[data-node-id="reading"]');
    expect(readingRows.length).toBe(1); // the other root is still closed

    // Open `reading` under this root; `paper.pdf` appears exactly once.
    container.querySelector<HTMLElement>('[data-node-id="reading"] .zg-twisty')!.click();
    expect(container.querySelectorAll('[data-node-id="paper.pdf"]').length).toBe(1);
  });
});

describe('vanilla Miller columns', () => {
  it('renders one column per selection', () => {
    const g = build();
    const cols = renderColumns(container, g);
    expect(container.querySelectorAll('.zg-column').length).toBe(1);

    cols.reveal([nodeId('research'), nodeId('reading')]);
    // roots + research's children + reading's children
    expect(container.querySelectorAll('.zg-column').length).toBe(3);
    expect(container.querySelector('[data-node-id="paper.pdf"]')).toBeTruthy();
  });
});

describe('vanilla tag input — the same edges, projected flat', () => {
  it('shows an item\'s groups as chips, and removing one leaves the others', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-1', 'urgent');

    const tags = renderTagInput(container, g);
    tags.show(nodeId('msg-1'));
    expect(container.querySelectorAll('.zg-chip').length).toBe(2);

    container.querySelector<HTMLElement>('.zg-chip-remove')!.click();
    expect(container.querySelectorAll('.zg-chip').length).toBe(1);
    expect(g.space.nodes.has(nodeId('msg-1'))).toBe(true); // removed ≠ deleted
  });
});

describe('vanilla breadcrumbs', () => {
  it('offers the other routes when a node is reachable more than one way', () => {
    const g = build();
    const crumbs = renderBreadcrumbs(container, g);
    crumbs.show(nodeId('reading'), [nodeId('research'), nodeId('reading')]);

    // The trail we arrived by is honoured...
    expect(container.querySelector('.zg-breadcrumbs')!.textContent).toContain('research');
    // ...and the fact that there IS another route is surfaced, not silently chosen.
    expect(container.querySelector('.zg-other-paths')!.textContent).toContain('1 other path');
  });
});
