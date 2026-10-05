/**
 * Per-family cardinality (reconciliation D26): "at most N values of this family per item".
 * The board case — an exclusive `Status` family — is the motivating one (Linear's label groups).
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, EXCLUSIVE, familyValuesOf, nodeId, validateProfile } from '../src/index.js';

const n = nodeId;

/** Status ⊃ {todo, doing, done}, exclusive; task-1 in todo. */
function board() {
  const g = defineGroups({ nodes: [{ id: n('status'), label: 'Status', family: EXCLUSIVE }] });
  for (const v of ['todo', 'doing', 'done']) g.add(`seed-${v}`, v); // make each value a group
  for (const v of ['todo', 'doing', 'done']) g.add(v, 'status');
  g.add('task-1', 'todo');
  return g;
}

describe('an exclusive family: one value per item', () => {
  it('refuses a second value, naming the family and the values', () => {
    const g = board();
    const r = g.add('task-1', 'done');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const v = r.violations[0]!;
      expect(v.code).toBe('maxPerFamily');
      expect(v.family).toBe('status');
      expect(v.node).toBe('task-1');
      expect([...v.values!].sort()).toEqual(['done', 'todo']);
      expect(v.message).toMatch(/exclusive/);
    }
    expect(g.parents('task-1')).toEqual(['todo']);
  });

  it('allows moving between values (remove + add in one delta)', () => {
    const g = board();
    expect(g.move('task-1', 'todo', 'done').ok).toBe(true);
    expect(g.parents('task-1')).toEqual(['done']);
  });

  it('counts branches, not edges: a value and its own sub-value are one column', () => {
    const g = board();
    g.add('seed-archived', 'archived');
    g.add('archived', 'done');
    expect(g.add('task-2', 'done').ok).toBe(true);
    expect(g.add('task-2', 'archived').ok).toBe(true); // still one column: done
    expect(familyValuesOf(g.space, n('status'), n('task-2'))).toEqual(['done']);
  });

  it('catches an item reaching two values through a polyhierarchical subgroup', () => {
    const g = board();
    g.add('seed-blocked', 'blocked');
    g.add('blocked', 'todo');
    g.add('task-3', 'blocked'); // one value so far
    const r = g.add('blocked', 'doing'); // now `blocked` — and task-3 — is under todo AND doing
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // every item under `blocked` would now sit in two columns
      expect(r.violations.map((v) => v.code)).toEqual(['maxPerFamily', 'maxPerFamily']);
      expect(r.violations.map((v) => v.node).sort()).toEqual(['seed-blocked', 'task-3']);
    }
  });

  it('applies to items, not to the values themselves or to unrelated groups', () => {
    const g = board();
    expect(g.add('task-1', 'urgent').ok).toBe(true); // outside the family
    expect(g.add('task-1', 'status').ok).toBe(true); // in the family root itself: no value
  });

  it('is reported by canAdd before the drop', () => {
    const g = board();
    expect(g.canAdd('task-1', 'done').map((v) => v.code)).toEqual(['maxPerFamily']);
    expect(g.canAdd('task-9', 'done')).toEqual([]);
  });
});

describe('a family rule set on existing data', () => {
  it('is refused when items already break it', () => {
    const g = defineGroups();
    g.add('a', 'red');
    g.add('a', 'blue');
    g.add('red', 'colour');
    g.add('blue', 'colour');
    const r = g.apply({ upsertNodes: [{ id: n('colour'), family: EXCLUSIVE }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('maxPerFamily');
  });

  it('allows a looser cap, and the rule undoes like any field', () => {
    const g = defineGroups();
    g.add('a', 'red');
    g.add('a', 'blue');
    g.add('red', 'colour');
    g.add('blue', 'colour');
    expect(g.apply({ upsertNodes: [{ id: n('colour'), family: { maxPerItem: 2 } }] }).ok).toBe(true);
    expect(g.add('green', 'colour').ok).toBe(true);
    g.add('seed', 'green');
    expect(g.add('a', 'green').ok).toBe(false); // a third colour
    g.undo(); // seed
    g.undo(); // green
    g.undo(); // the rule
    expect(g.space.nodes.get(n('colour'))!.family).toBeUndefined();
  });

  it('is checked by validateProfile on data the write path never saw', () => {
    const g = defineGroups();
    g.add('a', 'red');
    g.add('a', 'blue');
    g.add('red', 'colour');
    g.add('blue', 'colour');
    const tampered = {
      ...g.space,
      nodes: new Map(g.space.nodes).set(n('colour'), { id: n('colour'), family: EXCLUSIVE }),
    };
    expect(validateProfile(tampered).map((v) => v.code)).toEqual(['maxPerFamily']);
  });
});

describe('a cap of N > 1', () => {
  it('allows up to N values and refuses N + 1', () => {
    const g = defineGroups({ nodes: [{ id: n('topic'), family: { maxPerItem: 2 } }] });
    for (const t of ['a', 'b', 'c']) {
      g.add(`seed-${t}`, t);
      g.add(t, 'topic');
    }
    expect(g.add('doc', 'a').ok).toBe(true);
    expect(g.add('doc', 'b').ok).toBe(true);
    const r = g.add('doc', 'c');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.message).toMatch(/allows 2 per item\.$/);
  });
});
