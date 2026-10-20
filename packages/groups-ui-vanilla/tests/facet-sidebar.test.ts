/**
 * renderFacetSidebar (issue #15): a button per family (aria-expanded), an inline "any of" panel of
 * checkboxes, applied chips with "or"/"and", clear, focus kept across redraws, onSelect/setSelected.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineGroups, nodeId } from '@zodal/groups-core';
import { renderFacetSidebar } from '../src/index.js';

const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('rock', 'genre');
  g.add('jazz', 'genre');
  g.add('calm', 'mood');
  g.add('loud', 'mood');
  g.add('s1', 'rock');
  g.add('s1', 'calm');
  g.add('s2', 'rock');
  g.add('s2', 'loud');
  g.add('s3', 'jazz');
  g.add('s3', 'calm');
  return g;
};

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const toggleOf = (family: string) =>
  container.querySelector<HTMLButtonElement>(`.zg-facet-family[data-node-id="${family}"] .zg-facet-family-toggle`)!;
const panelOf = (family: string) => container.querySelector<HTMLElement>(`.zg-facet-family[data-node-id="${family}"] .zg-facet-family-panel`)!;
const boxOf = (value: string) => container.querySelector<HTMLInputElement>(`input[data-node-id="${value}"]`)!;
const tick = (value: string) => {
  const box = boxOf(value);
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('renderFacetSidebar', () => {
  it('one button per family; a click opens its panel (and closes the other)', () => {
    const onOpen = vi.fn();
    const s = renderFacetSidebar(container, build(), { families: ['genre', 'mood'], onOpen });
    expect(toggleOf('genre').getAttribute('aria-expanded')).toBe('false');
    expect(panelOf('genre').hidden).toBe(true);
    expect(toggleOf('genre').getAttribute('aria-controls')).toBe(panelOf('genre').id);

    toggleOf('genre').click();
    expect(s.open).toBe('genre');
    expect(toggleOf('genre').getAttribute('aria-expanded')).toBe('true');
    expect(panelOf('genre').hidden).toBe(false);
    expect(panelOf('genre').getAttribute('aria-label')).toBe('Any of genre');
    expect(onOpen).toHaveBeenLastCalledWith('genre');

    toggleOf('mood').click();
    expect(panelOf('genre').hidden).toBe(true);
    expect(panelOf('mood').hidden).toBe(false);
    toggleOf('mood').click();
    expect(s.open).toBeNull();
    expect(onOpen).toHaveBeenLastCalledWith(null);
  });

  it('ticking values filters (OR within, AND between) and tells the host', () => {
    const onSelect = vi.fn();
    const s = renderFacetSidebar(container, build(), { families: ['genre', 'mood'], open: 'genre', onSelect });
    tick('rock');
    expect([...s.selected]).toEqual(['rock']);
    expect(s.items()).toEqual(['s1', 's2']);
    expect(onSelect).toHaveBeenCalledTimes(1);
    tick('jazz');
    expect(s.items()).toEqual(['s1', 's2', 's3']);

    s.setOpen('mood');
    tick('calm');
    expect(s.items()).toEqual(['s1', 's3']);
    const applied = container.querySelector<HTMLElement>('.zg-facet-applied')!;
    expect(applied.hidden).toBe(false);
    expect(applied.textContent).toContain('genre:');
    expect(applied.querySelector('.zg-facet-or')!.textContent).toBe('or');
    expect(applied.querySelector('.zg-facet-and')!.textContent).toBe('and');
    expect(toggleOf('genre').getAttribute('aria-label')).toBe('genre, 2 selected');
    expect(toggleOf('genre').querySelector('.zg-facet-family-badge')!.textContent).toBe('2');
  });

  it('a chip removes its value, and focus moves to that family button', () => {
    const s = renderFacetSidebar(container, build(), { families: ['genre', 'mood'], selected: ['rock', 'calm'] });
    const chip = container.querySelector<HTMLButtonElement>('.zg-facet-chip[data-node-id="rock"]')!;
    expect(chip.getAttribute('aria-label')).toBe('Remove rock from genre');
    chip.focus();
    chip.click();
    expect([...s.selected]).toEqual(['calm']);
    expect(document.activeElement).toBe(toggleOf('genre'));
  });

  it('a family Clear and Clear all', () => {
    const s = renderFacetSidebar(container, build(), { families: ['genre', 'mood'], selected: ['rock', 'jazz', 'calm'], open: 'genre' });
    container.querySelector<HTMLButtonElement>('.zg-facet-clear')!.click();
    expect([...s.selected]).toEqual(['calm']);
    container.querySelector<HTMLButtonElement>('.zg-facet-clear-all')!.click();
    expect(s.selected.size).toBe(0);
    expect(container.querySelector<HTMLElement>('.zg-facet-applied')!.hidden).toBe(true);
  });

  it('keeps focus on the ticked box across the redraw', () => {
    renderFacetSidebar(container, build(), { families: ['genre'], open: 'genre' });
    boxOf('rock').focus();
    tick('rock');
    expect(document.activeElement).toBe(boxOf('rock'));
    expect(boxOf('rock').checked).toBe(true);
    expect(boxOf('rock').getAttribute('aria-label')).toBe('rock, 2 items');
  });

  it('setSelected does not echo; a model change that removes a selected value does', () => {
    const g = build();
    const onSelect = vi.fn();
    const s = renderFacetSidebar(container, g, { families: ['genre'], onSelect });
    expect([...s.setSelected(['jazz', 'ghost'])]).toEqual(['jazz']);
    expect(onSelect).not.toHaveBeenCalled();
    g.remove('jazz', 'genre');
    expect(s.selected.size).toBe(0);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('counts over a host item list, read on every render', () => {
    let items = ['s1', 's2', 's3'].map((x) => nodeId(x));
    const s = renderFacetSidebar(container, build(), { families: ['genre'], open: 'genre', items: () => items });
    expect(container.querySelector(`input[data-node-id="rock"] ~ .zg-facet-count`)!.textContent).toBe('2');
    items = [nodeId('s1')];
    s.render();
    expect(container.querySelector(`input[data-node-id="rock"] ~ .zg-facet-count`)!.textContent).toBe('1');
    expect(boxOf('jazz')).toBeNull(); // hidden: it would lead to zero items
  });

  it('destroy unsubscribes and removes the element', () => {
    const g = build();
    const s = renderFacetSidebar(container, g, { families: ['genre'] });
    s.destroy();
    expect(container.children.length).toBe(0);
    g.add('s4', 'jazz'); // no throw, no redraw
  });

  it('ids with spaces or colons: aria-controls resolves, and a removed chip hands focus to its own family', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('kind:rock', 'my genre');
    g.add('kind:jazz', 'my genre');
    g.add('s1', 'kind:rock');
    g.add('s2', 'kind:jazz');
    g.add('a:b', 'other');
    g.add('s1', 'a:b');
    renderFacetSidebar(container, g, { families: ['other', 'my genre'], selected: ['kind:rock', 'a:b'] });
    const toggle = toggleOf('my genre');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    const chip = container.querySelector<HTMLButtonElement>('.zg-facet-chip[data-node-id="kind:rock"]')!;
    chip.focus();
    chip.click();
    expect(document.activeElement).toBe(toggleOf('my genre'));
  });

  it("after a family's Clear, focus goes to that family's button", () => {
    renderFacetSidebar(container, build(), { families: ['genre', 'mood'], selected: ['calm'], open: 'mood' });
    const clear = container.querySelector<HTMLButtonElement>('.zg-facet-clear')!;
    clear.focus();
    clear.click();
    expect(document.activeElement).toBe(toggleOf('mood'));
  });

  it('a live region says what the filter matches', () => {
    renderFacetSidebar(container, build(), { families: ['genre', 'mood'], open: 'genre' });
    const live = container.querySelector<HTMLElement>('[role="status"]')!;
    expect(live.textContent).toBe('');
    tick('rock');
    expect(live.textContent).toBe('genre: rock. 2 items match');
    expect(container.querySelector('[role="status"]')).toBe(live); // persistent, not redrawn
  });

  it('an open family with nothing to offer says so', () => {
    const g = build();
    g.add('empty-family-value', 'misc'); // misc has only an item child: no group values
    renderFacetSidebar(container, g, { families: ['misc'], open: 'misc' });
    expect(panelOf('misc').querySelector('.zg-facet-none')!.textContent).toBe('No values');
  });
});
