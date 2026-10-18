/**
 * `toGroupChips`: the drill-down chip rows over nested groups (the phone counterpart of a facet
 * sidebar). Counts are de-duplicated over the closure; the view state is one path.
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, nodeId, type NodeId } from '@zodal/groups-core';
import { toGroupChips, groupChipItems, normalizeChipSelection, ALL_GROUPS } from '../src/index.js';

const id = (s: string) => nodeId(s);

/**
 * campfire > slow; song-1 in campfire, song-2 in slow (so in campfire by closure), song-3 in BOTH
 * slow and campfire (must count once), song-4 in learn, song-5 in nothing (not even in the space).
 */
const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('slow', 'campfire');
  g.add('song-1', 'campfire');
  g.add('song-2', 'slow');
  g.add('song-3', 'slow');
  g.add('song-3', 'campfire');
  g.add('song-4', 'learn');
  return g;
};
const pool = ['song-1', 'song-2', 'song-3', 'song-4', 'song-5'].map(id);
const chipText = (row: { chips: readonly { label: string; count: number }[] }) =>
  row.chips.map((c) => `${c.label} ${c.count}`);

describe('toGroupChips', () => {
  it('first row: All · roots with de-duplicated closure counts · Ungrouped', () => {
    const view = toGroupChips(build(), { items: pool });
    expect(view.rows).toHaveLength(1);
    expect(chipText(view.rows[0]!)).toEqual(['All 5', 'campfire 3', 'learn 1', 'Ungrouped 1']);
    expect(view.rows[0]!.chips[0]!.pressed).toBe(true);
    expect(view.rows[0]!.chips.find((c) => c.nodeId === 'campfire')!.hasChildren).toBe(true);
    expect(view.rows[0]!.chips.find((c) => c.nodeId === 'learn')!.hasChildren).toBe(false); // members, no subgroups
  });

  it('choosing a group with subgroups adds a row: All of it · its subgroups', () => {
    const view = toGroupChips(build(), { items: pool, selection: { path: [id('campfire')] } });
    expect(view.rows).toHaveLength(2);
    expect(view.rows[0]!.chips.find((c) => c.nodeId === 'campfire')!.pressed).toBe(true);
    expect(view.rows[1]!.label).toBe('In campfire');
    expect(chipText(view.rows[1]!)).toEqual(['All of campfire 3', 'slow 2']);
    expect(view.rows[1]!.chips[0]!.pressed).toBe(true);
    expect(view.rows[1]!.chips[1]!.target).toEqual({ path: ['campfire', 'slow'], ungrouped: false });
  });

  it('a subgroup pressed: its parent row says so, and the parent chip is no longer the pressed one', () => {
    const view = toGroupChips(build(), { items: pool, selection: { path: [id('campfire'), id('slow')] } });
    expect(view.rows).toHaveLength(2); // slow has no subgroups: no third row
    expect(view.rows[0]!.chips.find((c) => c.nodeId === 'campfire')!.pressed).toBe(false);
    expect(view.rows[1]!.chips.filter((c) => c.pressed).map((c) => c.key)).toEqual(['group:slow']);
  });

  it('a leaf group adds no row', () => {
    expect(toGroupChips(build(), { items: pool, selection: { path: [id('learn')] } }).rows).toHaveLength(1);
  });

  it('accessible names carry the count, and labels can be replaced', () => {
    const view = toGroupChips(build(), {
      items: pool,
      labels: { all: 'Tout', ungrouped: 'Sans groupe', count: (n) => `${n} chansons` },
    });
    expect(view.rows[0]!.chips[0]!.aria.label).toBe('Tout, 5 chansons');
    expect(view.rows[0]!.chips.at(-1)!.label).toBe('Sans groupe');
  });

  it('sorts by label by default, by count on request', () => {
    const g = build();
    g.add('song-5', 'zzz');
    g.add('song-6', 'zzz');
    g.add('song-7', 'zzz');
    const items = [...pool, id('song-6'), id('song-7')];
    const groupsOf = (view: ReturnType<typeof toGroupChips>) =>
      view.rows[0]!.chips.filter((c) => c.kind === 'group').map((c) => c.label);
    expect(groupsOf(toGroupChips(g, { items }))).toEqual(['campfire', 'learn', 'zzz']);
    expect(groupsOf(toGroupChips(g, { items, sort: 'count' }))).toEqual(['campfire', 'zzz', 'learn']);
  });

  it('hides empty groups and the Ungrouped chip, but never the chosen one', () => {
    const g = build();
    const items = [id('song-4')]; // only `learn` has anything in this pool
    expect(chipText(toGroupChips(g, { items }).rows[0]!)).toEqual(['All 1', 'learn 1']);
    const chosen = toGroupChips(g, { items, selection: { path: [id('campfire')] } }).rows[0]!;
    expect(chipText(chosen)).toEqual(['All 1', 'campfire 0', 'learn 1']);
    expect(chipText(toGroupChips(g, { items, selection: { ungrouped: true } }).rows[0]!)).toContain('Ungrouped 0');
    expect(chipText(toGroupChips(g, { items, hideEmpty: false }).rows[0]!)).toEqual([
      'All 1', 'campfire 0', 'learn 1', 'Ungrouped 0',
    ]);
  });

  it('ungrouped: false drops the chip', () => {
    expect(toGroupChips(build(), { items: pool, ungrouped: false }).rows[0]!.chips.map((c) => c.kind)).not.toContain('ungrouped');
  });

  it('a polyhierarchy keeps the route: the same subgroup under two parents, each row its own', () => {
    const g = build();
    g.add('slow', 'learn');
    const viaLearn = toGroupChips(g, { items: pool, selection: { path: [id('learn'), id('slow')] } });
    expect(viaLearn.selection.path).toEqual(['learn', 'slow']);
    expect(viaLearn.rows[1]!.label).toBe('In learn');
  });
});

describe('normalizeChipSelection', () => {
  it('drops an invalid tail (a deleted group, a non-child step)', () => {
    const g = build();
    expect(normalizeChipSelection(g, { path: [id('campfire'), id('learn')] }).path).toEqual(['campfire']);
    expect(normalizeChipSelection(g, { path: [id('nope')] })).toEqual(ALL_GROUPS);
    expect(normalizeChipSelection(g, { path: [id('song-1')] })).toEqual(ALL_GROUPS); // an item is no group
  });

  it('expands a lone subgroup to its primary path, so a deep link works', () => {
    expect(normalizeChipSelection(build(), { path: [id('slow')] }).path).toEqual(['campfire', 'slow']);
  });

  it('ungrouped wins only with an empty path', () => {
    const g = build();
    expect(normalizeChipSelection(g, { ungrouped: true })).toEqual({ path: [], ungrouped: true });
    expect(normalizeChipSelection(g, { ungrouped: true, path: [id('campfire')] })).toEqual({ path: ['campfire'], ungrouped: false });
  });

  it('is cycle-safe on read', () => {
    const g = build();
    const path: NodeId[] = [id('campfire'), id('slow'), id('campfire')];
    expect(normalizeChipSelection(g, { path }).path).toEqual(['campfire', 'slow']);
  });
});

describe('groupChipItems', () => {
  it('All, a group (closure, each item once, pool order), Ungrouped', () => {
    const g = build();
    expect(groupChipItems(g, ALL_GROUPS, pool)).toEqual(pool);
    expect(groupChipItems(g, { path: [id('campfire')], ungrouped: false }, pool)).toEqual(['song-1', 'song-2', 'song-3']);
    expect(groupChipItems(g, { path: [id('campfire'), id('slow')], ungrouped: false }, pool)).toEqual(['song-2', 'song-3']);
    expect(groupChipItems(g, { path: [], ungrouped: true }, pool)).toEqual(['song-5']);
  });
});

describe('allChipItems: an All chip that stands for another set (a "recently viewed" home)', () => {
  const viewed = ['song-4', 'song-1', 'song-4'].map(id); // most recent first; a repeat counts once

  it('counts the set on the All chip; groups and Ungrouped still count over the whole pool', () => {
    const view = toGroupChips(build(), { items: pool, allChipItems: viewed, labels: { all: 'Viewed' } });
    expect(chipText(view.rows[0]!)).toEqual(['Viewed 2', 'campfire 3', 'learn 1', 'Ungrouped 1']);
    expect(view.rows[0]!.chips[0]!.aria.label).toBe('Viewed, 2 items');
  });

  it('All gives the set in its own order; a group still gives its closure from the pool', () => {
    const g = build();
    expect(groupChipItems(g, ALL_GROUPS, pool, { allChipItems: viewed })).toEqual(['song-4', 'song-1']);
    expect(groupChipItems(g, { path: [id('campfire')], ungrouped: false }, pool, { allChipItems: viewed })).toEqual([
      'song-1',
      'song-2',
      'song-3',
    ]);
  });

  it('ids outside the pool are ignored: a deleted item, a group id', () => {
    const odd = ['gone-9', 'campfire', 'song-1'].map(id);
    expect(chipText(toGroupChips(build(), { items: pool, allChipItems: odd }).rows[0]!)[0]).toBe('All 1');
    expect(groupChipItems(build(), ALL_GROUPS, pool, { allChipItems: odd })).toEqual(['song-1']);
  });

  it('an empty set is an All chip with nothing in it, not the pool', () => {
    expect(chipText(toGroupChips(build(), { items: pool, allChipItems: [] }).rows[0]!)[0]).toBe('All 0');
    expect(groupChipItems(build(), ALL_GROUPS, pool, { allChipItems: [] })).toEqual([]);
  });
});
