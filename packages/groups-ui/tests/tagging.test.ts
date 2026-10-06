/**
 * The selection-level tagging descriptor: tri-state over a selection, the click cycle, the plan,
 * refusals explained before the click, and the session around them.
 */

import { describe, expect, it } from 'vitest';
import { EXCLUSIVE, defineGroups, nodeId, type NodeId } from '@zodal/groups-core';
import {
  applyTagging,
  createTag,
  createTaggingSession,
  describeOutcome,
  planToDelta,
  resetTag,
  setTagQuery,
  toTaggingView,
  toggleTag,
  EMPTY_TAGGING_STATE,
  type TaggingOptions,
  type TaggingState,
  type TaggingView,
} from '../src/index.js';

const ids = (...xs: string[]): NodeId[] => xs.map(nodeId);

/** Gmail: `work` holds a, b, c; `urgent` holds a; `personal` holds d (outside the selection). */
const mail = () => {
  const g = defineGroups({ profile: 'labels' });
  for (const m of ['a', 'b', 'c']) g.add(m, 'work');
  g.add('a', 'urgent');
  g.add('d', 'personal');
  return g;
};

const row = (view: TaggingView, group: string) => view.allRows.find((r) => r.group === group)!;

/** Click `group` `times` times through the pure API, returning the state. */
const click = (source: Parameters<typeof toTaggingView>[0], options: TaggingOptions, groups: string[], from: TaggingState = EMPTY_TAGGING_STATE) => {
  let state = from;
  for (const group of groups) state = toggleTag(state, row(toTaggingView(source, state, options), group));
  return state;
};

describe('tri-state over a mixed selection', () => {
  const g = mail();
  const options = { selection: ['a', 'b', 'c'] };
  const view = toTaggingView(g, EMPTY_TAGGING_STATE, options);

  it('is all / some / none per group, with counts', () => {
    expect([row(view, 'work').state, row(view, 'work').count]).toEqual(['all', 3]);
    expect([row(view, 'urgent').state, row(view, 'urgent').count]).toEqual(['some', 1]);
    expect([row(view, 'personal').state, row(view, 'personal').count]).toEqual(['none', 0]);
    expect(row(view, 'urgent').total).toBe(3);
  });

  it('maps the state to aria-checked, mixed for some', () => {
    expect(row(view, 'work').aria.checked).toBe('true');
    expect(row(view, 'urgent').aria.checked).toBe('mixed');
    expect(row(view, 'personal').aria.checked).toBe('false');
    expect(row(view, 'urgent').aria.label).toContain('1 of 3');
  });

  it('offers the groups by default and never the selected items themselves', () => {
    expect(view.allRows.map((r) => r.group).sort()).toEqual(['personal', 'urgent', 'work']);
  });

  it('starts with nothing staged and Apply disabled', () => {
    expect(view.plan.isEmpty).toBe(true);
    expect(view.canApply).toBe(false);
    expect(view.applyLabel).toBe('Apply');
  });

  it('counts direct memberships only: a subgroup is not its parent', () => {
    const h = defineGroups({ profile: 'polyhierarchy' });
    h.add('poodle', 'dog');
    h.add('dog', 'animal');
    h.add('x', 'poodle');
    const v = toTaggingView(h, EMPTY_TAGGING_STATE, { selection: ['x'] });
    expect(row(v, 'poodle').state).toBe('all');
    expect(row(v, 'dog').state).toBe('none'); // x is under dog by closure, not tagged with it
    expect(row(v, 'poodle').path).toBe('animal / dog / poodle');
  });
});

describe('the click cycle', () => {
  const g = mail();
  const options = { selection: ['a', 'b', 'c'] };
  const states = (group: string, clicks: number, opts: TaggingOptions = options) => {
    const out: string[] = [];
    let state = EMPTY_TAGGING_STATE;
    for (let i = 0; i < clicks; i++) {
      state = click(g, opts, [group], state);
      out.push(row(toTaggingView(g, state, opts), group).state);
    }
    return out;
  };

  it("Gmail: a mixed box goes to all, then none, then all", () => {
    expect(states('urgent', 3)).toEqual(['all', 'none', 'all']);
  });

  it('none → all → none, and all → none → all', () => {
    expect(states('personal', 2)).toEqual(['all', 'none']);
    expect(states('work', 2)).toEqual(['none', 'all']);
  });

  it('restoreMixed: some → all → none → some (the APG mixed checkbox)', () => {
    expect(states('urgent', 3, { ...options, restoreMixed: true })).toEqual(['all', 'none', 'some']);
  });

  it('back at the original state, nothing is staged', () => {
    const state = click(g, options, ['work', 'work']);
    expect(state.pending.size).toBe(0);
    expect(row(toTaggingView(g, state, options), 'work').pending).toBe(false);
  });

  it('`next` tells a renderer what the click will do', () => {
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, options);
    expect(row(v, 'urgent').next).toBe('all');
    expect(row(v, 'work').next).toBe('none');
  });
});

describe('the apply plan', () => {
  const g = mail();
  const options = { selection: ['a', 'b', 'c'] };
  const state = click(g, options, ['urgent', 'work']); // urgent → all, work → none
  const view = toTaggingView(g, state, options);

  it('adds only to the items not yet in the group, and removes from the ones that are', () => {
    expect(view.plan.add).toEqual([{ group: 'urgent', ids: ids('b', 'c') }]);
    expect(view.plan.remove).toEqual([{ group: 'work', ids: ids('a', 'b', 'c') }]);
    expect(view.plan.itemCount).toBe(3);
    expect(view.applyLabel).toBe('Apply to 3 items');
    expect(view.canApply).toBe(true);
  });

  it('is one bulkTag batch when nothing is refused (one call, one inverse, one undo step)', () => {
    expect(view.plan.batches).toEqual([{ ids: ids('a', 'b', 'c'), change: { add: ids('urgent'), remove: ids('work') } }]);
  });

  it('summarizes the staged changes as text', () => {
    expect(view.summary).toEqual(['Add “urgent” to 2 items', 'Remove “work” from 3 items']);
  });

  it('is a delta the model accepts, with exactly the intended effect', () => {
    const h = mail();
    const outcome = applyTagging(h, toTaggingView(h, state, options).plan);
    expect(outcome.failed).toEqual([]);
    expect(outcome.succeeded.sort()).toEqual(['a', 'b', 'c']);
    for (const m of ['a', 'b', 'c']) expect(h.parents(m)).toEqual(['urgent']);
    expect(h.parents('d')).toEqual(['personal']); // outside the selection: untouched
  });

  it('planToDelta removes every membership edge between the group and the item', () => {
    const delta = planToDelta(g.space, view.plan);
    expect(delta.removed).toHaveLength(3);
    expect(delta.added?.map((e) => [e.parent, e.child])).toEqual([
      ['urgent', 'b'],
      ['urgent', 'c'],
    ]);
  });

  it('never writes: the space is unchanged by computing a view or a plan', () => {
    expect(g.parents('b')).toEqual(['work']);
  });
});

describe('refusals are explained before the click', () => {
  /** `status` is an exclusive family with values todo and doing; a is in todo. */
  const board = () => {
    const g = defineGroups({ profile: 'polyhierarchy', nodes: [{ id: nodeId('status'), label: 'Status', family: EXCLUSIVE }] });
    g.add('todo', 'status');
    g.add('doing', 'status');
    g.add('a', 'todo');
    g.add('x', 'doing');
    return g;
  };

  it('an exclusive family: the items already holding a value are refused, and the family is named', () => {
    const g = board();
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['a', 'b'] });
    const doing = row(v, 'doing');
    expect(doing.disabled).toBe(false); // b can still take it
    expect(doing.refused.map((r) => r.id)).toEqual(['a']);
    expect(doing.reason).toContain('1 of 2');
    expect(doing.reason).toContain('“Status” allows one value per item');
    expect(doing.fix).toBe('Remove “a” from “todo” first.');
  });

  it('with refusals, items with the same change share a batch', () => {
    const g = board();
    g.add('y', 'later');
    const options = { selection: ['a', 'b'] };
    const v = toTaggingView(g, click(g, options, ['doing', 'later']), options);
    expect(v.plan.batches).toEqual([
      { ids: ids('a'), change: { add: ids('later'), remove: [] } }, // a is refused `doing`
      { ids: ids('b'), change: { add: ids('doing', 'later'), remove: [] } },
    ]);
  });

  it('refused items are left out of the plan and listed, never silently dropped', () => {
    const g = board();
    const options = { selection: ['a', 'b'] };
    const v = toTaggingView(g, click(g, options, ['doing']), options);
    expect(v.plan.add).toEqual([{ group: 'doing', ids: ids('b') }]);
    expect(v.plan.refused.map((r) => [r.id, r.group])).toEqual([['a', 'doing']]);
    expect(describeOutcome(v.plan, { succeeded: ['b'], failed: [] }, { space: g.space })).toMatch(
      /^Applied: tagged 1 item, 1 refused: “a”: “Status” allows one value per item/,
    );
  });

  it('a group no item can take is disabled, with the reason', () => {
    const g = board();
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['a'] });
    const doing = row(v, 'doing');
    expect(doing.disabled).toBe(true);
    expect(doing.aria.disabled).toBe(true);
    expect(doing.reason).toContain('would be in both “todo” and “doing”');
    expect(doing.aria.description).toContain('Remove “a” from “todo” first.');
  });

  it('the switch is legal: untick todo, then doing is no longer refused', () => {
    const g = board();
    const options = { selection: ['a'] };
    const state = click(g, options, ['todo', 'doing']);
    const v = toTaggingView(g, state, options);
    expect(row(v, 'doing').refused).toEqual([]);
    expect(v.plan.add).toEqual([{ group: 'doing', ids: ids('a') }]);
    expect(v.plan.remove).toEqual([{ group: 'todo', ids: ids('a') }]);
    expect(v.canApply).toBe(true);
    expect(applyTagging(g, v.plan).failed).toEqual([]);
    expect(g.parents('a')).toEqual(['doing']);
  });

  it('two staged values of an exclusive family conflict, and Apply is blocked', () => {
    const g = board();
    const options = { selection: ['b'] };
    const v = toTaggingView(g, click(g, options, ['todo', 'doing']), options);
    expect(v.plan.ok).toBe(false);
    expect(v.canApply).toBe(false);
    expect(v.plan.conflicts[0]!.message).toContain('“Status” allows one value per item');
    expect(row(v, 'todo').conflict).toBeTruthy();
    expect(row(v, 'doing').conflict).toBeTruthy();
  });

  it('family values with no members yet are still offered', () => {
    const g = defineGroups({ profile: 'polyhierarchy', nodes: [{ id: nodeId('status'), family: EXCLUSIVE }] });
    g.add('todo', 'status');
    g.add('done', 'status'); // nobody is done yet: `done` has no members, so it is not a group
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['a'] });
    expect(v.allRows.map((r) => r.group)).toContain('done');
  });

  it('a cycle is refused with its route (D15)', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper', 'reading');
    g.add('reading', 'research');
    // Tag the group `research` with `reading`, which is inside it.
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['research'] });
    const reading = row(v, 'reading');
    expect(reading.disabled).toBe(true);
    expect(reading.reason).toBe('That would create a loop: research → reading → research.');
    expect(reading.fix).toContain('“reading” is already inside “research”');
  });

  it('a single-homed profile refuses a second folder and suggests Move', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('report', 'documents');
    g.add('x', 'archive');
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['report'] });
    expect(row(v, 'archive').disabled).toBe(true);
    expect(row(v, 'archive').reason).toContain('can be in only 1 group here, and it is already in “documents”');
    expect(row(v, 'archive').fix).toContain('Move it to “archive” instead');
  });

  it('removing the last members of a group that would then break the item rules is refused (D29)', () => {
    // g2 is a group with two parents; emptied, it would be an item with two parents.
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { maxParentsPerItem: 1 } });
    g.add('x', 'g2');
    g.add('g2', 'p1');
    g.add('g2', 'p2');
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['x'] });
    const g2 = row(v, 'g2');
    expect(g2.state).toBe('all');
    expect(g2.disabled).toBe(true);
    expect(g2.removalViolations[0]!.code).toBe('maxParentsPerItem');
    expect(g2.reason).toContain('“g2”');
  });
});

describe('search and create', () => {
  const g = mail();
  const options: TaggingOptions = { selection: ['a', 'b'] };

  it('filters rows case- and accent-insensitively, keeping hidden staged changes in the plan', () => {
    const h = defineGroups({ profile: 'labels' });
    h.add('z', 'Réunion');
    h.add('z', 'work');
    let state = click(h, { selection: ['a'] }, ['work']);
    state = setTagQuery(state, 'reun');
    const v = toTaggingView(h, state, { selection: ['a'] });
    expect(v.rows.map((r) => r.group)).toEqual(['Réunion']);
    expect(v.plan.add).toEqual([{ group: 'work', ids: ids('a') }]); // hidden, still staged
    expect(v.query).toBe('reun');
  });

  it('offers Create for a name that matches no group, and stages it on the whole selection', () => {
    let state = setTagQuery(EMPTY_TAGGING_STATE, '  Reading ');
    let v = toTaggingView(g, state, options);
    expect(v.create).toMatchObject({ label: 'Reading', group: 'Reading', allowed: true, text: 'Create “Reading”' });
    expect(v.empty).toBe('No group matches “Reading”.');

    state = createTag(state, v.create);
    v = toTaggingView(g, state, options);
    const created = row(v, 'Reading');
    expect(created).toMatchObject({ isNew: true, state: 'all', pending: true });
    expect(v.plan.create).toEqual([{ group: 'Reading', label: 'Reading' }]);
    expect(v.plan.add).toContainEqual({ group: 'Reading', ids: ids('a', 'b') });
    expect(v.create).toBeUndefined(); // it exists now (staged)
    expect(state.query).toBe('  Reading '); // the typed text is never lost
  });

  it('does not offer Create for an existing name', () => {
    const v = toTaggingView(g, setTagQuery(EMPTY_TAGGING_STATE, 'URGENT'), options);
    expect(v.create).toBeUndefined();
    expect(v.rows.map((r) => r.group)).toEqual(['urgent']);
  });

  it('refuses Create where the profile keeps items out of groups, or when the host turns it off', () => {
    const strict = defineGroups({ profile: 'polyhierarchy', overrides: { groupsMayContainItems: false } });
    const v = toTaggingView(strict, setTagQuery(EMPTY_TAGGING_STATE, 'new'), { selection: ['x'] });
    expect(v.create).toMatchObject({ allowed: false, reason: 'New groups can’t be created here.' });
    expect(createTag(EMPTY_TAGGING_STATE, v.create)).toBe(EMPTY_TAGGING_STATE);

    const off = toTaggingView(g, setTagQuery(EMPTY_TAGGING_STATE, 'new'), { ...options, allowCreate: false });
    expect(off.create).toBeUndefined();
  });

  it('mintGroupId: a created group keeps its label on the node', () => {
    const h = mail();
    const opts: TaggingOptions = { ...options, mintGroupId: (label) => `tag:${label.toLowerCase()}` };
    let state = setTagQuery(EMPTY_TAGGING_STATE, 'To Read');
    state = createTag(state, toTaggingView(h, state, opts).create);
    const v = toTaggingView(h, state, opts);
    expect(v.plan.create).toEqual([{ group: 'tag:to read', label: 'To Read' }]);
    expect(applyTagging(h, v.plan).failed).toEqual([]);
    expect(h.space.nodes.get(nodeId('tag:to read'))?.label).toBe('To Read');
    expect(h.parents('a')).toContain('tag:to read');
  });

  it('resetTag drops one staged change, or all of them, and keeps the query', () => {
    let state = click(g, options, ['urgent', 'personal']);
    state = setTagQuery(state, 'u');
    expect(resetTag(state, 'urgent').pending.has(nodeId('urgent'))).toBe(false);
    expect(resetTag(state, 'urgent').pending.has(nodeId('personal'))).toBe(true);
    const cleared = resetTag(state);
    expect(cleared.pending.size).toBe(0);
    expect(cleared.query).toBe('u');
  });
});

describe('the session', () => {
  it('returns the same view until something changes, and notifies subscribers', () => {
    const g = mail();
    const s = createTaggingSession(g, { selection: ['a', 'b', 'c'] });
    const first = s.view();
    expect(s.view()).toBe(first);

    let calls = 0;
    s.subscribe(() => calls++);
    s.toggle('urgent');
    expect(calls).toBe(1);
    expect(s.view()).not.toBe(first);
    expect(row(s.view(), 'urgent').state).toBe('all');
  });

  it('apply() returns the plan and keeps it staged; complete() clears it and returns the announcement', () => {
    const g = mail();
    const s = createTaggingSession(g, { selection: ['a', 'b', 'c'] });
    s.setQuery('urg');
    s.toggle('urgent');
    const plan = s.apply();
    expect(plan.add).toEqual([{ group: 'urgent', ids: ids('b', 'c') }]);
    expect(s.view().plan.isEmpty).toBe(false); // still staged until the write is confirmed

    const outcome = applyTagging(g, plan);
    const text = s.complete(outcome);
    expect(text).toBe('Applied: tagged 2 items.');
    expect(s.view().plan.isEmpty).toBe(true);
    expect(s.view().query).toBe('urg'); // never lose the typed search text
    expect(row(s.view(), 'urgent').state).toBe('all'); // re-read from the live handle
  });

  it('complete() describes the plan that was handed out, not one recomputed after the write', () => {
    const g = mail();
    const s = createTaggingSession(g, { selection: ['a', 'b', 'c'] });
    s.toggle('work'); // all → none
    const outcome = applyTagging(g, s.apply());
    expect(s.complete(outcome)).toBe('Applied: untagged 3 items.');
  });

  it('announces refusals from the write, worded with the messages table', () => {
    const g = mail();
    const s = createTaggingSession(g, { selection: ['a', 'b', 'c'] });
    s.toggle('personal');
    const text = s.complete({
      succeeded: ['a', 'b'],
      failed: [{ id: 'c', reason: 'the provider rejected the write', code: 'recordWrite' }],
    });
    // The provider's raw text is for logs; the code is worded in plain language (review B8).
    expect(text).toBe('Applied: tagged 2 items, 1 refused: “c”: its record could not be saved.');
  });

  it('caps the listed refusals', () => {
    const g = mail();
    const s = createTaggingSession(g, { selection: ['a'] });
    s.toggle('personal');
    const failed = ['p', 'q', 'r', 's', 't'].map((id) => ({ id, reason: 'no' }));
    expect(describeOutcome(s.apply(), { succeeded: [], failed })).toBe(
      'Applied: tagged 0 items, 5 refused: “p”: no; “q”: no; “r”: no; and 2 more.',
    );
  });

  it('a new selection drops what was staged; a new space keeps it', () => {
    const g = mail();
    const s = createTaggingSession(() => g.space, { selection: ['a', 'b'] });
    s.toggle('personal');
    s.update({ source: () => g.space });
    expect(s.view().plan.isEmpty).toBe(false);
    s.update({ selection: ['a', 'b'] }); // same selection
    expect(s.view().plan.isEmpty).toBe(false);
    s.update({ selection: ['c'] });
    expect(s.view().plan.isEmpty).toBe(true);
    expect(s.view().selection).toEqual(['c']);
  });

  it('create() stages the typed name', () => {
    const g = mail();
    const s = createTaggingSession(g, { selection: ['a'] });
    s.setQuery('later');
    s.create();
    expect(s.apply().create).toEqual([{ group: 'later', label: 'later' }]);
  });

  it('host messages override the defaults', () => {
    const g = mail();
    const s = createTaggingSession(g, {
      selection: ['a', 'b'],
      messages: { tagging: { applyButton: (n) => `Appliquer à ${n} éléments` } },
    });
    s.toggle('personal');
    expect(s.view().applyLabel).toBe('Appliquer à 2 éléments');
  });

  it('labelOf names items by their record title', () => {
    const g = mail();
    const v = toTaggingView(g, EMPTY_TAGGING_STATE, {
      selection: ['a'],
      labelOf: (id) => (id === 'work' ? 'Work stuff' : undefined),
    });
    expect(row(v, 'work').label).toBe('Work stuff');
  });

  it('an empty selection says so and cannot apply', () => {
    const v = toTaggingView(mail(), EMPTY_TAGGING_STATE, { selection: [] });
    expect(v.empty).toBe('Select items to tag them.');
    expect(v.canApply).toBe(false);
    expect(v.allRows.every((r) => r.disabled)).toBe(true);
  });
});
