/**
 * Tombstones (reconciliation D25): deleting a node is a delta like any other, so undoing a group
 * delete — or the delete half of a merge — restores the node with its label, payload and edges.
 * And `invert` is exact: apply + invert gives back the same nodes and edges.
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  createGroupSpace,
  defineGroups,
  deleteNode,
  deleteNodeDelta,
  edgeId,
  invert,
  makeEdge,
  nodeId,
  toSnapshot,
  type EdgeDelta,
  type GroupSpace,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string) => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}`) });

/** Nodes and edges, id-sorted — "the same space", ignoring revision. */
const shape = (space: GroupSpace) => {
  const s = toSnapshot(space);
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return { nodes: [...s.nodes].sort(byId), edges: [...s.edges].sort(byId) };
};

const ok = <T,>(r: { ok: true; value: T } | { ok: false; violations: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.violations)}`);
  return r.value;
};

const library = () =>
  createGroupSpace({
    nodes: [{ id: n('reading'), label: 'Reading', payload: { colour: 'blue' } }],
    edges: [e('research', 'reading'), e('leisure', 'reading'), e('reading', 'paper'), e('reading', 'notes')],
  });

describe('deleteNodeDelta: the node travels as a tombstone', () => {
  it('lists every touching edge and the whole node', () => {
    const space = library();
    const delta = deleteNodeDelta(space, n('reading'));
    expect([...(delta.removed ?? [])].sort()).toEqual(['leisure>reading', 'reading>notes', 'reading>paper', 'research>reading']);
    expect(delta.removedNodes).toEqual([{ id: 'reading', label: 'Reading', payload: { colour: 'blue' } }]);
  });

  it('is empty for an unknown node', () => {
    expect(deleteNodeDelta(library(), n('nope'))).toEqual({ removed: [] });
  });

  it('deleteNode removes the node and its edges in one revision', () => {
    const space = library();
    const after = ok(deleteNode(space, n('reading')));
    expect(after.nodes.has(n('reading'))).toBe(false);
    expect(after.forward.has(n('reading'))).toBe(false);
    expect(after.inverse.has(n('paper'))).toBe(false);
    expect(after.revision).toBe(space.revision + 1);
  });

  it('undoing a group delete restores the label, payload and every edge', () => {
    const before = library();
    const delta = deleteNodeDelta(before, n('reading'));
    const after = ok(applyDelta(before, delta));
    const restored = ok(applyDelta(after, invert(before, delta)));
    expect(shape(restored)).toEqual(shape(before));
    expect(restored.nodes.get(n('reading'))).toEqual({ id: 'reading', label: 'Reading', payload: { colour: 'blue' } });
  });

  it('undoing a merge restores the merged-away group exactly', () => {
    const before = createGroupSpace({
      nodes: [{ id: n('todo'), label: 'Todo' }],
      edges: [e('todo', 'a'), e('todo', 'b'), e('to-do', 'b'), e('work', 'todo')],
    });
    const merge: EdgeDelta = {
      ...deleteNodeDelta(before, n('todo')),
      added: [e('to-do', 'a'), e('work', 'to-do')],
    };
    const merged = ok(applyDelta(before, merge));
    expect(merged.nodes.has(n('todo'))).toBe(false);
    expect(shape(ok(applyDelta(merged, invert(before, merge))))).toEqual(shape(before));
  });
});

describe('a tombstone needs its edges gone in the same delta', () => {
  it('refuses removing a node that edges still touch (danglingEdge), and names them', () => {
    const space = library();
    const result = applyDelta(space, { removedNodes: [space.nodes.get(n('reading'))!] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.code).toBe('danglingEdge');
      expect(result.violations[0]!.node).toBe('reading');
      expect(result.violations[0]!.message).toContain('deleteNodeDelta');
    }
  });

  it('refuses an edge added to a node the same delta removes', () => {
    const space = library();
    const result = applyDelta(space, { ...deleteNodeDelta(space, n('notes')), added: [e('inbox', 'notes')] });
    expect(result.ok).toBe(false);
  });

  it('ignores a tombstone for a node that does not exist', () => {
    expect(applyDelta(library(), { removedNodes: [{ id: n('ghost') }] }).ok).toBe(true);
  });
});

describe('invert is exact', () => {
  it('removes the nodes a delta created, by upsert or as an edge endpoint', () => {
    const before = library();
    const delta: EdgeDelta = { added: [e('inbox', 'fresh')], upsertNodes: [{ id: n('lonely'), label: 'Lonely' }] };
    const after = ok(applyDelta(before, delta));
    expect([...after.nodes.keys()]).toEqual(expect.arrayContaining(['inbox', 'fresh', 'lonely']));
    expect(shape(ok(applyDelta(after, invert(before, delta))))).toEqual(shape(before));
  });

  it('restores changed node fields and clears the ones the delta added', () => {
    const before = library();
    const delta: EdgeDelta = {
      upsertNodes: [
        { id: n('reading'), label: 'To read', family: { maxPerItem: 2 } },
        { id: n('paper'), payload: { pages: 3 } },
      ],
    };
    const after = ok(applyDelta(before, delta));
    expect(after.nodes.get(n('reading'))).toEqual({ id: 'reading', label: 'To read', payload: { colour: 'blue' }, family: { maxPerItem: 2 } });
    const undone = ok(applyDelta(after, invert(before, delta)));
    expect(undone.nodes.get(n('reading'))).toEqual({ id: 'reading', label: 'Reading', payload: { colour: 'blue' } });
    expect(undone.nodes.get(n('paper'))).toEqual({ id: 'paper' });
  });

  it('an upsert field set to undefined clears it', () => {
    const after = ok(applyDelta(library(), { upsertNodes: [{ id: n('reading'), label: undefined }] }));
    expect(after.nodes.get(n('reading'))).toEqual({ id: 'reading', payload: { colour: 'blue' } });
  });

  it('invert of invert is the original effect', () => {
    const s0 = library();
    const d = deleteNodeDelta(s0, n('reading'));
    const s1 = ok(applyDelta(s0, d));
    const undo = invert(s0, d);
    const s2 = ok(applyDelta(s1, undo));
    const redo = invert(s1, undo);
    expect(shape(ok(applyDelta(s2, redo)))).toEqual(shape(s1));
  });
});

describe('validation judges group-ness against the delta END state', () => {
  it('a delta re-adding a group with its parents listed first still sees it as a group', () => {
    // Under `labels`, a GROUP may have one parent; an ITEM may have many. If `x` were judged an item
    // while its parent edges are checked (its own children come later in the list), two parents
    // would slip through. Order must not matter.
    const s = createGroupSpace({ profile: 'labels' });
    const result = applyDelta(s, { added: [e('p1', 'x'), e('p2', 'x'), e('x', 'item')] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain('maxParentsPerGroup');
  });

  it('undoing a group delete works whatever order the edges are restored in', () => {
    const before = createGroupSpace({
      profile: 'flatTags',
      edges: [e('holiday', 'photo'), e('family', 'photo'), e('holiday', 'video')],
    });
    const d = deleteNodeDelta(before, n('holiday'));
    const after = ok(applyDelta(before, d));
    const undo = invert(before, d);
    const reversed: EdgeDelta = { ...undo, added: [...(undo.added ?? [])].reverse() };
    expect(shape(ok(applyDelta(after, reversed)))).toEqual(shape(before));
  });
});

describe('the facade: destroy is undoable', () => {
  it('g.destroy + g.undo brings the group back, with its label and members', () => {
    const g = defineGroups({ nodes: [{ id: n('work'), label: 'Work' }] });
    g.add('msg-1', 'work');
    g.add('msg-2', 'work');
    g.add('work', 'inbox');
    g.destroy('work');
    expect(g.space.nodes.has(n('work'))).toBe(false);
    expect(g.parents('msg-1')).toEqual([]);

    expect(g.undo()).toBe(true);
    expect(g.space.nodes.get(n('work'))).toEqual({ id: 'work', label: 'Work' });
    expect(g.children('work').sort()).toEqual(['msg-1', 'msg-2']);
    expect(g.parents('work')).toEqual(['inbox']);
  });

  it('undoing an add removes the nodes the add created', () => {
    const g = defineGroups();
    g.add('a', 'g');
    g.undo();
    expect(g.space.nodes.size).toBe(0);
  });
});

describe('stale tombstones and re-creation are refused, never merged (S3)', () => {
  it('a tombstone that does not match the current node is refused', () => {
    const space = library();
    const r = applyDelta(space, {
      removed: deleteNodeDelta(space, n('reading')).removed,
      removedNodes: [{ id: n('reading'), label: 'NOT-READING' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toEqual(['staleTombstone']);
  });

  it('undoing an add after the auto-created group was relabelled does not delete it', () => {
    const s0 = createGroupSpace();
    const d: EdgeDelta = { added: [e('g', 'a')] };
    const s1 = ok(applyDelta(s0, d));
    const s2 = ok(applyDelta(s1, { upsertNodes: [{ id: n('g'), label: 'Mine now' }] }));
    const r = applyDelta(s2, invert(s0, d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain('staleTombstone');
  });

  it('undoing a delete after the node was re-created is refused (nodeExists), not merged', () => {
    const s0 = library();
    const d = deleteNodeDelta(s0, n('reading'));
    const s1 = ok(applyDelta(s0, d));
    const s2 = ok(applyDelta(s1, { upsertNodes: [{ id: n('reading'), label: 'A new reading list' }] }));
    const undo = invert(s0, d);
    expect(undo.addedNodes?.map((x) => x.id)).toEqual(['reading']);
    const r = applyDelta(s2, undo);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain('nodeExists');
  });

  it('addedNodes creates a node, and refuses an existing id', () => {
    const s = ok(applyDelta(createGroupSpace(), { addedNodes: [{ id: n('x'), label: 'X' }] }));
    expect(s.nodes.get(n('x'))).toEqual({ id: 'x', label: 'X' });
    const again = applyDelta(s, { addedNodes: [{ id: n('x') }] });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.violations[0]!.code).toBe('nodeExists');
  });

  it('an added edge may not reuse a live edge id (remove it in the same delta to replace it)', () => {
    const s = library();
    const reuse = makeEdge(n('archive'), n('paper'), { id: edgeId('reading>paper') });
    const r = applyDelta(s, { added: [reuse] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('edgeIdExists');
    const replaced = ok(applyDelta(s, { removed: [edgeId('reading>paper')], added: [reuse] }));
    expect(replaced.edges.get(edgeId('reading>paper'))!.parent).toBe('archive');
  });
});
