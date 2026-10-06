/**
 * Every `Violation` code has a sentence and (where there is something to do) a fix; cycles name
 * their route, cardinality names its family; the table is overridable.
 */

import { describe, expect, it } from 'vitest';
import {
  EXCLUSIVE,
  applyDelta,
  createGroupSpace,
  defineGroups,
  edgeId,
  makeEdge,
  nodeId,
  type Violation,
} from '@zodal/groups-core';
import {
  VIOLATION_CODES,
  VIOLATION_MESSAGES,
  explainViolation,
  explainViolations,
  resolveDrop,
  resolveMessages,
  sentence,
  toTreeRows,
} from '../src/index.js';

/** Every code in groups-core's `Violation['code']` union, spelled out. */
const ALL_CODES = [
  'cycle',
  'maxDepth',
  'maxParentsPerItem',
  'maxParentsPerGroup',
  'maxGroupsPerItem',
  'groupsMayContainGroups',
  'groupsMayContainItems',
  'groupsAreItems',
  'unknownEdgeKind',
  'disjointEdgeKind',
  'selfEdge',
  'duplicateEdge',
  'danglingEdge',
  'maxPerFamily',
  'invalidFamilyRule',
  'malformed',
  'staleTombstone',
  'nodeExists',
  'edgeIdExists',
  'conflict',
] as const satisfies readonly Violation['code'][];

// Compile-time: ALL_CODES covers the union (a code added to groups-core makes this `false`).
type Missing = Exclude<Violation['code'], (typeof ALL_CODES)[number]>;
const covered: [Missing] extends [never] ? true : false = true;

const edge = makeEdge(nodeId('parent'), nodeId('child'), { id: edgeId('e1') });

describe('every Violation code has a message', () => {
  it('the table covers exactly the codes groups-core reports', () => {
    expect(covered).toBe(true);
    expect([...VIOLATION_CODES].sort()).toEqual([...ALL_CODES].sort());
  });

  it.each(ALL_CODES)('%s → a sentence that is not the raw model message', (code) => {
    const v: Violation = {
      code,
      message: 'RAW',
      edge,
      node: nodeId('child'),
      family: nodeId('fam'),
      values: [nodeId('v1'), nodeId('v2')],
      path: [nodeId('child'), nodeId('parent')],
      expectedRevision: 3,
      actualRevision: 5,
    };
    const e = explainViolation(v);
    expect(e.code).toBe(code);
    expect(e.message.length).toBeGreaterThan(10);
    expect(e.message).not.toBe('RAW');
    if (code !== 'duplicateEdge') expect(e.fix, `${code} has a fix`).toBeTruthy();
  });

  it('an unknown code (a newer groups-core) falls back to the model message instead of throwing', () => {
    const v = { code: 'somethingNew', message: 'Model says no.' } as unknown as Violation;
    expect(explainViolation(v).message).toBe('Model says no.');
  });
});

describe('messages from real violations', () => {
  it('a cycle names its route, closed, with labels (D15)', () => {
    const g = defineGroups({
      profile: 'polyhierarchy',
      nodes: [
        { id: nodeId('r'), label: 'Research' },
        { id: nodeId('rd'), label: 'Reading' },
        { id: nodeId('p'), label: 'Paper' },
      ],
    });
    g.add('rd', 'r');
    g.add('p', 'rd');
    const [v] = g.canAdd('r', 'p');
    const e = explainViolation(v!, { space: g.space });
    expect(e.message).toBe('That would create a loop: Research → Reading → Paper → Research.');
    expect(e.fix).toBe('“Paper” is already inside “Research”. Choose a group outside “Research”, or first take “Reading” out of “Research”.');
  });

  it('cardinality names the family, its limit, and the value to give up', () => {
    const g = defineGroups({
      profile: 'polyhierarchy',
      nodes: [{ id: nodeId('status'), label: 'Status', family: EXCLUSIVE }, { id: nodeId('bug'), label: 'Bug 12' }],
    });
    g.add('todo', 'status');
    g.add('doing', 'status');
    g.add('bug', 'todo');
    const v = g.canAdd('bug', 'doing').find((x) => x.code === 'maxPerFamily')!;
    const e = explainViolation(v, { space: g.space });
    expect(e.message).toBe('“Status” allows one value per item, and “Bug 12” would be in both “todo” and “doing”.');
    expect(e.fix).toBe('Remove “Bug 12” from “todo” first.');
  });

  it('a non-exclusive family says its number', () => {
    const g = defineGroups({ profile: 'polyhierarchy', nodes: [{ id: nodeId('topics'), family: { maxPerItem: 2 } }] });
    for (const t of ['a', 'b', 'c']) g.add(t, 'topics');
    g.add('x', 'a');
    g.add('x', 'b');
    const v = g.canAdd('x', 'c').find((y) => y.code === 'maxPerFamily')!;
    expect(explainViolation(v, { space: g.space }).message).toBe(
      '“topics” allows 2 values per item, and “x” would be in 3: “a”, “b” and “c”.',
    );
  });

  it('flat tags: nesting is refused in both directions, each with its own sentence', () => {
    const g = defineGroups({ profile: 'flatTags' });
    g.add('photo', 'holiday');
    g.add('holiday2', 'travel');
    const intoGroup = explainViolation(g.canAdd('holiday', 'travel')[0]!, { space: g.space });
    expect(intoGroup.message).toBe('“holiday” is a group, and groups can\'t contain other groups here.');
    const becoming = explainViolation(g.canAdd('photo', 'holiday2')[0]!, { space: g.space });
    expect(becoming.message).toContain('“holiday2” is itself in a group');
  });

  it('maxGroupsPerItem lists the groups the item could leave', () => {
    const g = defineGroups({ profile: 'labels', overrides: { maxGroupsPerItem: 2 } });
    g.add('m', 'work');
    g.add('m', 'urgent');
    const v = g.canAdd('m', 'later').find((x) => x.code === 'maxGroupsPerItem')!;
    const e = explainViolation(v, { space: g.space });
    expect(e.message).toBe('“m” already has the most groups an item may have here (2).');
    expect(e.fix).toBe('Remove it from one of “work” and “urgent” first.');
  });

  it('a conflict reports both revisions', () => {
    const e = explainViolation({ code: 'conflict', message: 'x', expectedRevision: 4, actualRevision: 7 });
    expect(e.message).toBe('These groups were changed elsewhere since you loaded them (you had version 4; it is now 7).');
    expect(e.fix).toBe('Reload and apply your change again.');
  });

  it('danglingEdge from the model', () => {
    const space = createGroupSpace({ profile: 'polyhierarchy' });
    const r = applyDelta(space, { added: [makeEdge(nodeId('g'), nodeId('i'))] });
    if (!r.ok) throw new Error('setup');
    const bad = applyDelta(r.value, { removedNodes: [r.value.nodes.get(nodeId('g'))!] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(explainViolation(bad.violations[0]!, { space: r.value }).message).toBe(
      '“g” still has memberships, so it can\'t be deleted on its own.',
    );
  });
});

describe('the table is the host\'s to override', () => {
  it('per code, through explainViolation', () => {
    const e = explainViolation(
      { code: 'selfEdge', message: 'x' },
      { messages: { selfEdge: () => ({ message: 'Un groupe ne peut pas se contenir.', fix: 'Choisissez-en un autre.' }) } },
    );
    expect(sentence(e)).toBe('Un groupe ne peut pas se contenir. Choisissez-en un autre.');
  });

  it('resolveMessages merges overrides onto the defaults', () => {
    const m = resolveMessages({ tagging: { cancelButton: 'Annuler' } });
    expect(m.tagging.cancelButton).toBe('Annuler');
    expect(m.tagging.applying).toBe('Applying…');
    expect(m.violations.cycle).toBe(VIOLATION_MESSAGES.cycle);
  });

  it('labelOf names nodes the host knows better (record titles)', () => {
    const e = explainViolation(
      { code: 'duplicateEdge', message: 'x', edge },
      { labelOf: (id) => ({ child: 'Quarterly report', parent: 'Finance' })[id as string] },
    );
    expect(e.message).toBe('“Quarterly report” is already in “Finance”.');
  });

  it('identical sentences are reported once', () => {
    const v: Violation = { code: 'selfEdge', message: 'x' };
    expect(explainViolations([v, v])).toHaveLength(1);
  });

  it('drag-and-drop refusals use the same table, with a fix', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('report', 'documents');
    g.add('x', 'archive');
    const rows = toTreeRows(g, { expandAll: true });
    const drop = resolveDrop(g, {
      source: rows.find((r) => r.nodeId === 'report')!.source,
      target: rows.find((r) => r.nodeId === 'archive')!.source,
    });
    expect(drop.reason).toBe('“report” can be in only 1 group here, and it is already in “documents”.');
    expect(drop.fix).toContain('Move it to “archive” instead');
  });
});
