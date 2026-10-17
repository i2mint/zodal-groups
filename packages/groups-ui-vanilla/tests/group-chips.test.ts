/**
 * `renderGroupChips`: drill-down chip rows over nested groups, the path emitted for the URL and
 * settable from it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, nodeId, type NodeId } from '@zodal/groups-core';
import type { GroupChipsSelection } from '@zodal/groups-ui';
import { createVanillaRegistry, renderGroupChips } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

/** campfire > slow; song-1 in campfire; song-2, song-3 in slow; song-4 in learn; song-5 nowhere. */
const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('slow', 'campfire');
  g.add('song-1', 'campfire');
  g.add('song-2', 'slow');
  g.add('song-3', 'slow');
  g.add('song-4', 'learn');
  return g;
};
const songs = ['song-1', 'song-2', 'song-3', 'song-4', 'song-5'].map(nodeId);

const rowTexts = () =>
  [...container.querySelectorAll('.zg-group-chips-row')].map((row) =>
    [...row.querySelectorAll('.zg-group-chip')].map(
      (b) => `${b.querySelector('.zg-group-chip-label')!.textContent} ${b.querySelector('.zg-group-chip-count')!.textContent}`,
    ),
  );
const chip = (depth: number, label: string) =>
  [...container.querySelectorAll<HTMLElement>(`.zg-group-chips-row[data-depth="${depth}"] .zg-group-chip`)].find(
    (b) => b.querySelector('.zg-group-chip-label')!.textContent === label,
  )!;
const pressed = () =>
  [...container.querySelectorAll('[aria-pressed="true"] .zg-group-chip-label')].map((e) => e.textContent);

describe('renderGroupChips', () => {
  it('one row: All · groups with counts · Ungrouped, as toggle buttons in labelled groups', () => {
    renderGroupChips(container, build(), { items: songs });
    expect(rowTexts()).toEqual([['All 5', 'campfire 3', 'learn 1', 'Ungrouped 1']]);
    expect(pressed()).toEqual(['All']);
    const row = container.querySelector('.zg-group-chips-row')!;
    expect(row.getAttribute('role')).toBe('group');
    expect(row.getAttribute('aria-label')).toBe('Groups');
    expect(chip(0, 'campfire').getAttribute('aria-label')).toBe('campfire, 3 items');
    expect(chip(0, 'campfire').classList.contains('has-children')).toBe(true);
  });

  it('choosing a group with subgroups opens a second row, and emits the path', () => {
    const seen: GroupChipsSelection[] = [];
    renderGroupChips(container, build(), { items: songs, onNavigate: (s) => seen.push(s) });
    chip(0, 'campfire').click();
    expect(rowTexts()[1]).toEqual(['All of campfire 3', 'slow 2']);
    expect(seen.at(-1)).toEqual({ path: ['campfire'], ungrouped: false });

    chip(1, 'slow').click();
    expect(seen.at(-1)).toEqual({ path: ['campfire', 'slow'], ungrouped: false });
    expect(pressed()).toEqual(['slow']);
    expect(chip(0, 'campfire').classList.contains('is-on-path')).toBe(true); // what opened this row

    chip(1, 'All of campfire').click();
    expect(seen.at(-1)).toEqual({ path: ['campfire'], ungrouped: false });

    chip(0, 'Ungrouped').click();
    expect(seen.at(-1)).toEqual({ path: [], ungrouped: true });
    expect(rowTexts()).toHaveLength(1);

    chip(0, 'All').click();
    expect(seen.at(-1)).toEqual({ path: [], ungrouped: false });
    expect(seen).toHaveLength(5);
  });

  it('choosing the chip that is already pressed does nothing', () => {
    const seen: GroupChipsSelection[] = [];
    renderGroupChips(container, build(), { items: songs, onNavigate: (s) => seen.push(s) });
    chip(0, 'All').click();
    expect(seen).toEqual([]);
  });

  it('items() is what the selection matches: closure, each item once, pool order', () => {
    const chips = renderGroupChips(container, build(), { items: songs });
    expect(chips.items()).toEqual(songs);
    chip(0, 'campfire').click();
    expect(chips.items()).toEqual(['song-1', 'song-2', 'song-3']);
    chip(0, 'Ungrouped').click();
    expect(chips.items()).toEqual(['song-5']);
  });

  it('the host sets the path (from its URL) without an echo; an invalid tail is dropped', () => {
    const seen: GroupChipsSelection[] = [];
    const chips = renderGroupChips(container, build(), {
      items: songs,
      selection: { path: [nodeId('campfire'), nodeId('slow')] },
      onNavigate: (s) => seen.push(s),
    });
    expect(pressed()).toEqual(['slow']);
    expect(chips.setSelection({ path: [nodeId('learn'), nodeId('gone')] })).toEqual({ path: ['learn'], ungrouped: false });
    expect(pressed()).toEqual(['learn']);
    expect(chips.setSelection({ path: [nodeId('slow')] }).path).toEqual(['campfire', 'slow']); // a deep link
    expect(seen).toEqual([]);
  });

  it('counts follow the model; removing the chosen group emits where we are now', () => {
    const g = build();
    const seen: GroupChipsSelection[] = [];
    renderGroupChips(container, g, { items: songs, selection: { path: [nodeId('learn')] }, onNavigate: (s) => seen.push(s) });
    g.add('song-5', 'learn');
    expect(chip(0, 'learn').textContent).toContain('2');
    expect(seen).toEqual([]);
    g.destroy('learn');
    expect(seen).toEqual([{ path: [], ungrouped: false }]);
    expect(pressed()).toEqual(['All']);
  });

  it('items may be a function, read on every render', () => {
    const pool: NodeId[] = [nodeId('song-1')];
    const chips = renderGroupChips(container, build(), { items: () => pool });
    expect(rowTexts()[0]![0]).toBe('All 1');
    pool.push(nodeId('song-5'));
    chips.render();
    expect(rowTexts()[0]).toContain('Ungrouped 1');
  });

  it('keeps focus on the chosen chip across the redraw', () => {
    renderGroupChips(container, build(), { items: songs });
    chip(0, 'campfire').focus();
    chip(0, 'campfire').click();
    expect(document.activeElement).toBe(chip(0, 'campfire'));
  });

  it('destroy() stops listening to the model', () => {
    const g = build();
    const seen: GroupChipsSelection[] = [];
    const chips = renderGroupChips(container, g, { items: songs, selection: { path: [nodeId('learn')] }, onNavigate: (s) => seen.push(s) });
    chips.destroy();
    g.destroy('learn');
    expect(seen).toEqual([]);
    expect(container.querySelector('.zg-group-chips')).toBeNull();
  });

  it('is the registry\'s groupChips surface', () => {
    const registry = createVanillaRegistry();
    expect(registry.resolve({ surface: 'groupChips', profile: build().profile })).toBe(renderGroupChips);
  });
});
