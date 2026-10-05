/**
 * Snapshots: the flat, persisted shape (D20). Structure is checked on read; the profile is not (D8).
 */

import { describe, expect, it } from 'vitest';
import {
  createGroupSpace,
  detectCycles,
  edgeId,
  fromSnapshot,
  makeEdge,
  nodeId,
  parseSnapshot,
  toSnapshot,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string) => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}`) });

describe('toSnapshot / fromSnapshot', () => {
  it('round-trips nodes, edges, revision and the indexes through JSON', () => {
    const space = createGroupSpace({
      nodes: [{ id: n('work'), label: 'Work', payload: { colour: 'red' }, family: { maxPerItem: 1 } }],
      edges: [e('work', 'msg-1'), e('urgent', 'msg-1')],
    });
    const back = fromSnapshot(parseSnapshot(JSON.parse(JSON.stringify(toSnapshot(space)))), { profile: 'labels' });
    expect(back.revision).toBe(space.revision);
    expect([...back.nodes.values()]).toEqual([...space.nodes.values()]);
    expect([...back.edges.values()]).toEqual([...space.edges.values()]);
    expect([...back.inverse.get(n('msg-1'))!].sort()).toEqual(['urgent>msg-1', 'work>msg-1']);
    expect(back.profile.name).toBe('labels');
  });

  it('does not validate: cyclic or profile-violating data still loads (read path)', () => {
    const cyclic = fromSnapshot({ nodes: [], edges: [e('a', 'b'), e('b', 'a')] }, { profile: 'filesystem' });
    expect(detectCycles(cyclic).length).toBeGreaterThan(0);
  });

  it('gives a missing edge endpoint a bare node', () => {
    const s = fromSnapshot({ nodes: [], edges: [e('g', 'i')] });
    expect([...s.nodes.keys()].sort()).toEqual(['g', 'i']);
  });
});

describe('parseSnapshot names the first problem', () => {
  const cases: [string, unknown, RegExp][] = [
    ['not an object', [], /^snapshot: /],
    ['no nodes array', { edges: [] }, /^nodes: expected an array/],
    ['a node without an id', { nodes: [{ label: 'x' }], edges: [] }, /^nodes\[0\]\.id: /],
    ['a duplicate node id', { nodes: [{ id: 'a' }, { id: 'a' }], edges: [] }, /^nodes\[1\]\.id: duplicate/],
    ['a bad family rule', { nodes: [{ id: 'a', family: { maxPerItem: -1 } }], edges: [] }, /^nodes\[0\]\.family: /],
    ['an edge without a parent', { nodes: [], edges: [{ id: 'e', child: 'c', kind: 'contains' }] }, /^edges\[0\]\.parent: /],
    ['a non-string order', { nodes: [], edges: [{ id: 'e', parent: 'p', child: 'c', kind: 'contains', order: 3 }] }, /^edges\[0\]\.order: /],
    ['a duplicate edge id', { nodes: [], edges: [{ id: 'e', parent: 'p', child: 'c', kind: 'k' }, { id: 'e', parent: 'q', child: 'c', kind: 'k' }] }, /^edges\[1\]\.id: duplicate/],
    ['a negative revision', { nodes: [], edges: [], revision: -1 }, /^revision: /],
  ];
  for (const [what, value, message] of cases) {
    it(what, () => expect(() => parseSnapshot(value)).toThrow(message));
  }

  it('accepts a well-formed snapshot unchanged', () => {
    const value = { nodes: [{ id: 'a', label: 'A' }], edges: [{ id: 'e', parent: 'a', child: 'b', kind: 'contains', meta: {} }], revision: 2 };
    expect(parseSnapshot(value)).toBe(value);
  });
});

describe('readonlySpace', () => {
  it('reads like the space, refuses every mutation, and works as input to the pure functions', async () => {
    const { readonlySpace, applyDelta, childrenOf } = await import('../src/index.js');
    const space = createGroupSpace({ edges: [e('g', 'a'), e('g', 'b')] });
    const view = readonlySpace(space);
    expect(view.nodes.size).toBe(3);
    expect([...view.forward.get(n('g'))!].sort()).toEqual(['g>a', 'g>b']);
    expect(() => (view.nodes as Map<unknown, unknown>).set('x', {})).toThrow(/read-only/);
    expect(() => (view.forward.get(n('g')) as Set<unknown>).clear()).toThrow(/read-only/);
    for (const [, set] of view.inverse) expect(() => (set as Set<unknown>).add('x')).toThrow(/read-only/);
    const next = applyDelta(view, { added: [e('g', 'c')] });
    expect(next.ok && childrenOf(next.value, n('g')).sort()).toEqual(['a', 'b', 'c']);
    expect(space.edges.size).toBe(2); // the original is untouched
  });
});
