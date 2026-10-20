/**
 * The multi-family facet sidebar (issue #15): OR within a family, AND between families, each
 * family counted over what the other families leave (N+1), closure included.
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, nodeId } from '@zodal/groups-core';
import { clearFacetFamily, facetFamilyValues, toFacetSidebar, toggleFacetValue } from '../src/index.js';

/** genre: rock (with indie inside), jazz; mood: calm, loud. s5 is in no group. */
const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('rock', 'genre');
  g.add('jazz', 'genre');
  g.add('indie', 'rock');
  g.add('calm', 'mood');
  g.add('loud', 'mood');
  g.add('s1', 'indie');
  g.add('s1', 'calm');
  g.add('s2', 'rock');
  g.add('s2', 'loud');
  g.add('s3', 'jazz');
  g.add('s3', 'calm');
  g.add('s4', 'jazz');
  return g;
};
const ITEMS = ['s1', 's2', 's3', 's4', 's5'].map((s) => nodeId(s));
const counts = (view: ReturnType<typeof toFacetSidebar>, family: string) =>
  Object.fromEntries(view.families.find((f) => f.family === family)!.values.map((v) => [v.group, v.count]));

describe('toFacetSidebar', () => {
  it('lists each family with closure counts, and matches everything when nothing is selected', () => {
    const view = toFacetSidebar(build(), { families: ['genre', 'mood'], items: ITEMS });
    expect(view.families.map((f) => f.family)).toEqual(['genre', 'mood']);
    expect(counts(view, 'genre')).toEqual({ rock: 2, jazz: 2 }); // s1 reaches rock through indie
    expect(counts(view, 'mood')).toEqual({ calm: 2, loud: 1 });
    expect(view.matching).toEqual(ITEMS);
    expect(view.applied).toEqual([]);
    expect(view.summary).toBe('');
  });

  it('a family ignores its own selection (N+1); the others count over what it leaves', () => {
    const view = toFacetSidebar(build(), { families: ['genre', 'mood'], items: ITEMS, selected: ['rock'] });
    expect(counts(view, 'genre')).toEqual({ rock: 2, jazz: 2 });
    expect(counts(view, 'mood')).toEqual({ calm: 1, loud: 1 });
    expect(view.matching).toEqual(['s1', 's2']);
  });

  it('ORs within a family', () => {
    const view = toFacetSidebar(build(), { families: ['genre', 'mood'], items: ITEMS, selected: ['rock', 'jazz'] });
    expect(view.matching).toEqual(['s1', 's2', 's3', 's4']);
    expect(view.applied[0]!.text).toBe('genre: jazz or rock');
  });

  it('ANDs between families, and says so', () => {
    const view = toFacetSidebar(build(), { families: ['genre', 'mood'], items: ITEMS, selected: ['rock', 'calm'] });
    expect(view.matching).toEqual(['s1']);
    expect(counts(view, 'genre')).toEqual({ rock: 1, jazz: 1 });
    expect(view.summary).toBe('genre: rock and mood: calm');
    expect(view.applied.map((a) => a.values.map((v) => v.removeLabel))).toEqual([['Remove rock from genre'], ['Remove calm from mood']]);
  });

  it('hides values that lead nowhere, but never a selected one', () => {
    const g = build();
    expect(counts(toFacetSidebar(g, { families: ['genre', 'mood'], items: ITEMS, selected: ['jazz'] }), 'mood')).toEqual({ calm: 1 });
    const view = toFacetSidebar(g, { families: ['genre', 'mood'], items: ITEMS, selected: ['jazz', 'loud'] });
    expect(counts(view, 'mood')).toEqual({ calm: 1, loud: 0 });
    expect(view.matching).toEqual([]);
    expect(counts(toFacetSidebar(g, { families: ['genre', 'mood'], items: ITEMS, selected: ['jazz'], hideEmpty: false }), 'mood')).toEqual({ calm: 1, loud: 0 });
  });

  it('drops selected ids that are no listed family value, and unknown families', () => {
    const view = toFacetSidebar(build(), { families: ['genre', 'nope'], items: ITEMS, selected: ['calm', 'ghost', 'rock', 'indie'] });
    expect(view.families.map((f) => f.family)).toEqual(['genre']);
    expect([...view.selected]).toEqual(['rock']); // indie is rock's child, not a genre value
    expect(view.dropped).toEqual(['calm', 'ghost', 'indie']); // in request order, so a host can clean its URL
  });

  it('dropped is empty when everything applies, and lists a repeat once', () => {
    expect(toFacetSidebar(build(), { families: ['genre'], items: ITEMS, selected: ['rock'] }).dropped).toEqual([]);
    expect(toFacetSidebar(build(), { families: ['genre'], items: ITEMS, selected: ['x', 'x'] }).dropped).toEqual(['x']);
  });

  it('open: only a listed family; the aria says expanded and how many are selected', () => {
    const g = build();
    const view = toFacetSidebar(g, { families: ['genre', 'mood'], items: ITEMS, selected: ['rock', 'jazz'], open: 'genre' });
    const genre = view.families[0]!;
    expect(view.open).toBe('genre');
    expect(genre.open).toBe(true);
    expect(genre.aria).toEqual({ label: 'genre, 2 selected', expanded: true, panelLabel: 'Any of genre' });
    expect(genre.values.find((v) => v.group === 'rock')!.aria).toEqual({ label: 'rock, 2 items', checked: true });
    expect(toFacetSidebar(g, { families: ['genre'], open: 'mood' }).open).toBeNull();
  });

  it('sorts by label on request, and takes label overrides', () => {
    const view = toFacetSidebar(build(), {
      families: ['mood'],
      items: ITEMS,
      sort: 'label',
      selected: ['calm', 'loud'],
      labels: { or: 'ou', family: (f, n) => `${f} (${n})` },
    });
    expect(view.families[0]!.values.map((v) => v.group)).toEqual(['calm', 'loud']);
    expect(view.applied[0]!.text).toBe('mood: calm ou loud');
    expect(view.families[0]!.aria.label).toBe('mood (2)');
  });
});

describe('toFacetSidebar: the edges (review of #29)', () => {
  it('a value shared by two families is selected in both, and clearing either clears it', () => {
    const g = build();
    g.add('rock', 'mood'); // `rock` is now also a mood value
    const view = toFacetSidebar(g, { families: ['genre', 'mood'], items: ITEMS, selected: ['rock'] });
    expect(view.applied.map((a) => a.family)).toEqual(['genre', 'mood']);
    expect(view.families.map((f) => f.selectedCount)).toEqual([1, 1]);
    expect(view.matching).toEqual(['s1', 's2']);
    expect([...clearFacetFamily(g, view.selected, 'mood')]).toEqual([]);
  });

  it("values: 'open' computes only the open family's panel", () => {
    const view = toFacetSidebar(build(), { families: ['genre', 'mood'], items: ITEMS, values: 'open', open: 'mood' });
    expect(view.families[0]!.values).toEqual([]);
    expect(counts(view, 'mood')).toEqual({ calm: 2, loud: 1 });
  });

  it('a repeated item is counted and matched once', () => {
    const view = toFacetSidebar(build(), { families: ['genre'], items: [...ITEMS, nodeId('s1')], selected: ['rock'] });
    expect(view.matching).toEqual(['s1', 's2']);
  });
});

describe('selection helpers', () => {
  it('toggleFacetValue and clearFacetFamily return new sets', () => {
    const g = build();
    const start = new Set([nodeId('rock'), nodeId('calm')]);
    const next = toggleFacetValue(start, 'jazz');
    expect([...next].sort()).toEqual(['calm', 'jazz', 'rock']);
    expect(start.size).toBe(2);
    expect([...toggleFacetValue(next, 'rock')].sort()).toEqual(['calm', 'jazz']);
    expect([...clearFacetFamily(g, next, 'genre')]).toEqual(['calm']);
    expect(facetFamilyValues(g, 'genre').sort()).toEqual(['jazz', 'rock']);
  });
});
