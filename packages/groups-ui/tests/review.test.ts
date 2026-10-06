/**
 * Regressions from the PR #8 reviews (plan semantics and the session): each test failed before
 * its fix.
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, makeEdge, nodeId, type NodeId } from '@zodal/groups-core';
import {
  applyTagging,
  createTaggingSession,
  resolveMessages,
  describeOutcome,
  planToDelta,
  toTaggingView,
  toggleTag,
  EMPTY_TAGGING_STATE,
  type TaggingOptions,
  type TaggingPlan,
  type TaggingState,
  type TaggingView,
} from '../src/index.js';

const row = (view: TaggingView, group: string) => view.allRows.find((r) => r.group === group)!;
const click = (source: Parameters<typeof toTaggingView>[0], options: TaggingOptions, groups: string[]) => {
  let state: TaggingState = EMPTY_TAGGING_STATE;
  for (const group of groups) state = toggleTag(state, row(toTaggingView(source, state, options), group));
  return state;
};

/** Every (item, group) pair a write of the batches would add — must be exactly `plan.add`. */
const batchPairs = (plan: TaggingPlan) =>
  plan.batches.flatMap((b) => b.ids.flatMap((id) => b.change.add.map((g) => `${id}>${g}`))).sort();
const planPairs = (plan: TaggingPlan) => plan.add.flatMap((a) => a.ids.map((id) => `${id}>${a.group}`)).sort();

describe('batches write exactly the plan (review B1)', () => {
  it('an item already in a group through another membership kind is not given a second edge', () => {
    // a is in G via is_a: bulkTag's "already there" check is per kind, so a batch adding G to a
    // would write a G:contains edge the plan does not contain.
    const g = defineGroups({ profile: 'polyhierarchy', edges: [makeEdge(nodeId('G'), nodeId('a'), { kind: 'is_a' })] });
    g.add('z', 'H');
    const options = { selection: ['a', 'b'] };
    const plan = toTaggingView(g, click(g, options, ['G', 'H']), options).plan;
    expect(planPairs(plan)).toEqual(['a>H', 'b>G', 'b>H']);
    expect(batchPairs(plan)).toEqual(planPairs(plan));
  });

  it('still one batch when every changing item takes every added group', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('z', 'G');
    g.add('a', 'work');
    const options = { selection: ['a', 'b'] };
    const plan = toTaggingView(g, click(g, options, ['G', 'work', 'work']), options).plan; // G → all, work → none
    expect(plan.batches).toHaveLength(1);
    expect(batchPairs(plan)).toEqual(planPairs(plan));
  });

  it('planToDelta and applyTagging add exactly the plan too', () => {
    const g = defineGroups({ profile: 'polyhierarchy', edges: [makeEdge(nodeId('G'), nodeId('a'), { kind: 'is_a' })] });
    g.add('z', 'H');
    const options = { selection: ['a', 'b'] };
    const plan = toTaggingView(g, click(g, options, ['G', 'H']), options).plan;
    const delta = planToDelta(g.space, plan);
    expect(delta.added!.map((e) => `${e.child}>${e.parent}`).sort()).toEqual(planPairs(plan));
    applyTagging(g, plan);
    expect([...g.space.edges.values()].filter((e) => e.child === 'a').map((e) => `${e.parent}:${e.kind}`).sort()).toEqual([
      'G:is_a',
      'H:contains',
    ]);
  });
});

describe('a created group keeps its label on every route (review B2)', () => {
  it('the batch carries the label of a group it creates', () => {
    const g = defineGroups({ profile: 'labels' });
    const opts: TaggingOptions = { selection: ['a'], mintGroupId: (l) => l.toLowerCase().replace(/\s+/g, '-') };
    const s = createTaggingSession(g, opts);
    s.setQuery('To Read');
    s.create();
    expect(s.apply().batches).toEqual([{ ids: ['a'], change: { add: ['to-read'], remove: [], labels: { 'to-read': 'To Read' } } }]);
  });
});

describe('a stale plan is detected (review B3)', () => {
  const build = () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('a', 'G');
    g.add('b', 'G');
    g.add('z', 'H');
    return g;
  };

  it('the plan is stamped with the revision it was computed against', () => {
    const g = build();
    const plan = createTaggingSession(g, { selection: ['a', 'c'] }).apply();
    expect(plan.revision).toBe(g.space.revision);
  });

  it('complete() says when a row did not reach its staged state, and keeps that row staged', () => {
    const g = build();
    const s = createTaggingSession(g, { selection: ['a', 'b', 'c'] });
    s.toggle('G'); // some → all: add c
    const plan = s.apply();
    g.remove('a', 'G'); // another writer, between computing the plan and writing it
    const text = s.complete(applyTagging(g, plan));
    expect(text).toBe('Applied: tagged 1 item. “G” was changed elsewhere and is not as staged yet; review it and apply again.');
    expect(row(s.view(), 'G')).toMatchObject({ state: 'all', pending: true });
    expect(s.view().plan.add).toEqual([{ group: 'G', ids: ['a'] }]);
  });

  it('refused or failed items do not count as "changed elsewhere"', () => {
    const g = build();
    const s = createTaggingSession(g, { selection: ['a', 'c'] });
    s.toggle('H');
    const plan = s.apply();
    const text = s.complete({ succeeded: ['a'], failed: [{ id: 'c', reason: 'x', code: 'recordWrite' }] });
    expect(text).not.toContain('elsewhere');
    expect(s.view().plan.isEmpty).toBe(true);
    expect(plan.add).toEqual([{ group: 'H', ids: ['a', 'c'] }]);
  });
});

describe('toggles reuse the work of rows they cannot affect (review B4)', () => {
  it('an added group leaves the other rows untouched (same objects)', () => {
    const g = defineGroups({ profile: 'labels' });
    for (let k = 0; k < 5; k++) g.add(`o${k}`, `g${k}`);
    const s = createTaggingSession(g, { selection: ['a', 'b'] });
    const before = s.view().allRows;
    s.toggle('g1');
    const after = s.view().allRows;
    for (const r of before) if (r.group !== 'g1') expect(after.find((x) => x.group === r.group)).toBe(r);
  });

  it('a refusal is explained only when read', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('a', 'docs');
    g.add('x', 'archive');
    const r = row(toTaggingView(g, EMPTY_TAGGING_STATE, { selection: ['a'] }), 'archive').refused[0]!;
    expect(Object.getOwnPropertyDescriptor(r, 'explained')?.get).toBeTypeOf('function');
    expect(r.explained.code).toBe('maxParentsPerItem');
  });
});

describe('staged removals that the model refuses are reported (review B5)', () => {
  // A guard, not a regression test: the whole-plan dry run already caught this case before the
  // fix, and no case exists that only the removals-only branch catches (see its comment in
  // tagging.ts: the branch is defensive).
  it('a staged removal made illegal by another writer is a conflict, and Apply is blocked', () => {
    // g2 has two parents and two members; x leaving it is fine while z stays.
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { maxParentsPerItem: 1 } });
    g.add('x', 'g2');
    g.add('z', 'g2');
    g.add('g2', 'p1');
    g.add('g2', 'p2');
    const s = createTaggingSession(() => g.space, { selection: ['x'] });
    s.toggle('g2'); // all → none
    g.remove('z', 'g2'); // now x leaving empties g2, which would be an item with two parents
    s.update({ source: () => g.space });
    const plan = s.view().plan;
    expect(plan.ok).toBe(false);
    expect(plan.conflicts[0]!.code).toBe('maxParentsPerItem');
  });
});

describe('the session keeps what was staged (review A2)', () => {
  it('a re-ordered selection is the same selection', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('z', 'G');
    const s = createTaggingSession(g, { selection: ['a', 'b'] });
    s.toggle('G');
    s.update({ selection: ['b', 'a', 'a'] });
    expect(s.view().plan.isEmpty).toBe(false);
    expect(s.view().notice).toBeUndefined();
  });

  it('a different selection drops what was staged, and says so', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('z', 'G');
    g.add('z', 'H');
    const s = createTaggingSession(g, { selection: ['a'] });
    s.toggle('G');
    s.toggle('H');
    s.update({ selection: ['c'] });
    expect(s.view().plan.isEmpty).toBe(true);
    expect(s.view().notice).toBe('The selection changed, so 2 staged changes were discarded.');
    s.toggle('G');
    expect(s.view().notice).toBeUndefined(); // a notice is said once
  });
});

describe('the accessible name carries the state and what is staged (review A5)', () => {
  it('says how many are in the group, and what Apply would do', () => {
    const g = defineGroups({ profile: 'labels' });
    for (const m of ['a', 'b', 'c']) g.add(m, 'work');
    g.add('a', 'urgent');
    g.add('d', 'personal');
    const s = createTaggingSession(g, { selection: ['a', 'b', 'c'] });
    expect(row(s.view(), 'urgent').aria.label).toBe('urgent, on 1 of 3');
    expect(row(s.view(), 'work').aria.label).toBe('work, on all 3');
    expect(row(s.view(), 'personal').aria.label).toBe('personal, on none');
    s.toggle('urgent');
    s.toggle('work');
    expect(row(s.view(), 'urgent').aria.label).toBe('urgent, on 1 of 3, will add to 2');
    expect(row(s.view(), 'work').aria.label).toBe('work, on all 3, will remove from 3');
  });
});

describe('failures are announced in plain language (review B8)', () => {
  it('maps a failure code to a sentence instead of the provider\'s raw text', () => {
    const plan = createTaggingSession(defineGroups({ profile: 'labels' }), { selection: ['a'] }).apply();
    const text = describeOutcome(plan, {
      succeeded: [],
      failed: [{ id: 'a', code: 'recordWrite', reason: "ENOSPC: no space left on device, write '/data/a.json'" }],
    });
    expect(text).toBe('Applied: tagged 0 items, 1 refused: “a”: its record could not be saved.');
  });

  it('keeps the reason when there is no code it knows', () => {
    const plan = createTaggingSession(defineGroups({ profile: 'labels' }), { selection: ['a'] }).apply();
    expect(describeOutcome(plan, { succeeded: [], failed: [{ id: 'a', reason: 'Quota exceeded.' }] })).toBe(
      'Applied: tagged 0 items, 1 refused: “a”: Quota exceeded.',
    );
  });
});

// Keep the NodeId import used (the selection API takes plain strings).
export type _N = NodeId;

describe('verification round (head b692ebb)', () => {
  const slug = (l: string) => l.toLowerCase().replace(/\s+/g, '-');

  it('1 — a backing that stores no labels refuses a Create whose id differs from the typed name, before the click', () => {
    const g = defineGroups({ profile: 'labels' });
    const s = createTaggingSession(g, { selection: ['a', 'b'], mintGroupId: slug, storesLabels: false });
    s.setQuery('To Read');
    expect(s.view().create).toMatchObject({
      allowed: false,
      reason: 'Groups here are stored by name, so “To Read” would be saved as “to-read”. Type “to-read” to create it.',
    });
    s.create();
    expect(s.view().plan.isEmpty).toBe(true);
    expect(s.view().canApply).toBe(false);
    // A name that is its own id needs no label: allowed, and no batch carries `labels`.
    s.setQuery('later');
    s.create();
    expect(s.apply().batches).toEqual([{ ids: ['a', 'b'], change: { add: ['later'], remove: [] } }]);
  });

  it('4 — overriding one failure reason keeps the others', () => {
    const m = resolveMessages({ tagging: { failureReasons: { recordWrite: 'son enregistrement n’a pas pu être sauvé' } } });
    expect(m.tagging.failureReasons.recordWrite).toBe('son enregistrement n’a pas pu être sauvé');
    expect(m.tagging.failureReasons.notFound).toBe('it no longer exists');
  });
});
