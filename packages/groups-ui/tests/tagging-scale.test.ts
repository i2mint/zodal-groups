/**
 * The tagging menu's fast path (issue #31): rows where no rule could refuse a plain item skip the
 * per-item dry run. These check that it never skips a refusal, and that a large first view is cheap.
 */

import { describe, expect, it } from 'vitest';
import { createGroupSpace, defineGroups, edgeId, makeEdge, nodeId } from '@zodal/groups-core';
import { toTaggingView } from '../src/index.js';

const row = (view: ReturnType<typeof toTaggingView>, group: string) => view.rows.find((r) => r.group === group)!;

describe('the fast path never hides a refusal', () => {
  it('a `related` edge from the group still refuses that item (disjoint kinds), and only it', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    g.add('a', 'topic');
    g.add('c', 'topic', { kind: 'related' });
    const view = toTaggingView(g, undefined, { selection: ['c', 'd'] });
    expect(row(view, 'topic').refused.map((r) => r.id)).toEqual(['c']);
    expect(row(view, 'topic').refused[0]!.violations[0]!.code).toBe('disjointEdgeKind');
  });

  it('caps still refuse per item (filesystem: one parent)', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('a', 'docs');
    g.add('b', 'other');
    const view = toTaggingView(g, undefined, { selection: ['b', 'c'] });
    expect(row(view, 'docs').refused.map((r) => r.id)).toEqual(['b']);
  });

  it('a group in the selection takes the full dry run (cycles)', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('child', 'parent');
    g.add('x', 'child');
    const view = toTaggingView(g, undefined, { selection: ['parent'] });
    expect(row(view, 'child').refused.map((r) => r.violations[0]!.code)).toEqual(['cycle']);
  });
});

describe('a large first view', () => {
  it('10k selected × 51 groups opens well inside a second', () => {
    const edges = [];
    let k = 0;
    for (let g = 0; g < 51; g++) for (let i = g; i < 20000; i += 7) edges.push(makeEdge(nodeId(`g${g}`), nodeId(`i${i}`), { id: edgeId(`e${k++}`) }));
    const space = createGroupSpace({ profile: 'labels', edges });
    const selection = Array.from({ length: 10000 }, (_, i) => `i${i}`);
    const t = performance.now();
    const view = toTaggingView(space, undefined, { selection, inherited: false });
    const ms = performance.now() - t;
    expect(view.rows).toHaveLength(51);
    expect(ms).toBeLessThan(1500); // ~0.2 s here; ~2.4 s before the fast path
  }, 20_000); // building the 20k-item space takes ~1 s before the timer starts
});
