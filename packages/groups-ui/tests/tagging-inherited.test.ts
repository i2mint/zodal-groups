/**
 * TagRow.inherited (issue #9): selected items in a group only through a subgroup.
 */

import { describe, expect, it } from 'vitest';
import { defineGroups } from '@zodal/groups-core';
import { createTaggingSession, toTaggingView, EMPTY_TAGGING_STATE, type TaggingView } from '../src/index.js';

/** animal ⊃ dog ⊃ poodle; rex is a poodle, fido is a dog, tom is in animal directly. */
const zoo = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('dog', 'animal');
  g.add('poodle', 'dog');
  g.add('rex', 'poodle');
  g.add('fido', 'dog');
  g.add('tom', 'animal');
  return g;
};
const row = (view: TaggingView, group: string) => view.allRows.find((r) => r.group === group)!;

describe('TagRow.inherited', () => {
  it('counts selected items in the group only through a subgroup', () => {
    const view = toTaggingView(zoo(), EMPTY_TAGGING_STATE, { selection: ['rex', 'fido', 'tom'] });
    expect(row(view, 'animal')).toMatchObject({ count: 1, inherited: 2, state: 'some' }); // tom direct; rex, fido through
    expect(row(view, 'dog')).toMatchObject({ count: 1, inherited: 1 }); // fido direct; rex through poodle
    expect(row(view, 'poodle')).toMatchObject({ count: 1, inherited: 0 });
  });

  it('is in the accessible name, and not in the tri-state', () => {
    const view = toTaggingView(zoo(), EMPTY_TAGGING_STATE, { selection: ['rex'] });
    expect(row(view, 'dog').state).toBe('none');
    expect(row(view, 'dog').aria.label).toBe('animal / dog, on none, 1 more through a subgroup');
    expect(row(view, 'poodle').aria.label).not.toContain('through');
  });

  it('inherited: false skips the walk', () => {
    const view = toTaggingView(zoo(), EMPTY_TAGGING_STATE, { selection: ['rex'], inherited: false });
    expect(row(view, 'dog').inherited).toBe(0);
  });

  it('a diamond counts once; an item both direct and through a subgroup counts as direct', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('b', 'top');
    g.add('c', 'top');
    g.add('x', 'b');
    g.add('x', 'c');
    g.add('y', 'b');
    g.add('y', 'top');
    const view = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['x', 'y'] });
    expect(row(view, 'top')).toMatchObject({ count: 1, inherited: 1 });
  });

  it('a session follows the model: inherited is recomputed when the space changes, not per toggle', () => {
    const g = zoo();
    const session = createTaggingSession(g, { selection: ['rex'] });
    expect(session.view().allRows.find((r) => r.group === 'animal')!.inherited).toBe(1);
    session.toggle('animal'); // staged: inherited describes now, unchanged
    expect(session.view().allRows.find((r) => r.group === 'animal')!.inherited).toBe(1);
    session.reset();
    g.remove('rex', 'poodle');
    expect(session.view().allRows.find((r) => r.group === 'animal')?.inherited ?? 0).toBe(0);
  });
});
