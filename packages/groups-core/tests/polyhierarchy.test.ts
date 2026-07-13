/**
 * The behaviours that only exist once you leave trees behind — and the ones the research says
 * everyone gets wrong. Each `describe` here corresponds to a documented trap.
 */

import { describe, expect, it } from 'vitest';
import {
  defineGroups,
  descendants,
  detectCycles,
  createGroupSpace,
  expandedForPath,
  makeEdge,
  nodeId,
  projectTree,
  twinsOf,
} from '../src/index.js';

const n = nodeId;

describe('cycles are refused on write — with the path that explains why', () => {
  it('refuses a cycle and names the offending route', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('reading', 'research');
    g.add('research', 'archive');

    const result = g.add('archive', 'reading'); // would close the loop
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations[0]!;
      expect(v.code).toBe('cycle');
      // The path is the point: a bare `false` is indistinguishable from a bug, because under
      // polyhierarchy the cycle can close through a branch the user cannot see.
      expect(v.path).toBeDefined();
      expect(v.message).toContain('→');
    }
  });

  it('reports why a drop target is invalid, before the drop', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('reading', 'research');
    g.add('research', 'archive');

    expect(g.canAdd('archive', 'reading')).toHaveLength(1);
    expect(g.canAdd('archive', 'reading')[0]!.code).toBe('cycle');
    expect(g.canAdd('somethingElse', 'reading')).toHaveLength(0);
  });

  it('refuses self-containment', () => {
    const g = defineGroups();
    const result = g.add('a', 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]!.code).toBe('selfEdge');
  });
});

describe('projections are cycle-SAFE on read, because we do not own our data', () => {
  it('terminates on a cyclic space built behind applyDelta\'s back', () => {
    // Simulates an import or a foreign store adapter that never heard of our invariant.
    // Real taxonomies DO contain cycles (the ODP study; Wikipedia's category graph).
    const space = createGroupSpace({
      edges: [
        makeEdge(n('a'), n('b')),
        makeEdge(n('b'), n('c')),
      ],
    });
    const cyclic = {
      ...space,
      edges: new Map([...space.edges, [n('cyc') as never, makeEdge(n('c'), n('a'))]]),
      forward: new Map([...space.forward, [n('c'), new Set([n('cyc') as never])]]),
      inverse: new Map([...space.inverse, [n('a'), new Set([n('cyc') as never])]]),
    } as typeof space;

    // The guarantee is simply: these return, rather than hanging or blowing the stack.
    expect(() => descendants(cyclic, n('a'))).not.toThrow();
    expect(detectCycles(cyclic).length).toBeGreaterThan(0);

    const rows = projectTree(cyclic, { roots: [n('a')], expandAll: true });
    expect(rows.some((r) => r.isRecursive)).toBe(true);
    // The recursive row is rendered as a leaf, not expanded again.
    expect(rows.find((r) => r.isRecursive)!.hasChildren).toBe(false);
  });
});

describe('the diamond problem — ancestors are de-duplicated', () => {
  it('reports a shared ancestor exactly once', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    // item → A; A → B and A → C; B → D and C → D. D is reachable twice.
    g.add('item', 'A');
    g.add('A', 'B');
    g.add('A', 'C');
    g.add('B', 'D');
    g.add('C', 'D');

    const ancestors = g.ancestors('item');
    expect(ancestors.filter((a) => a === 'D')).toHaveLength(1);
    expect(ancestors.sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('counts an item reachable by two routes exactly once', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('item', 'A');
    g.add('A', 'B');
    g.add('A', 'C');
    g.add('B', 'D');
    g.add('C', 'D');

    // The naive `Σ children.count` would say 2. That answer is *wrong*, not broken — which is
    // exactly why it survives code review for a year.
    expect(g.count('D', { expand: 'closure' })).toBe(1);
  });
});

describe('closure semantics are per edge KIND — the wheel/car/vehicle problem', () => {
  it('does NOT conclude that a wheel is a vehicle', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    // wheel --part_of--> car --is_a--> vehicle
    g.add('wheel', 'car', { kind: 'part_of' });
    g.add('car', 'vehicle', { kind: 'is_a' });

    const ancestors = g.ancestors('wheel');
    expect(ancestors).toContain('car');
    // The chain does not compose, so closure stops. This is why SKOS makes `broader`
    // non-transitive, and it is the difference between a toy and a thesaurus.
    expect(ancestors).not.toContain('vehicle');
  });

  it('DOES conclude that a poodle is an animal', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    g.add('poodle', 'dog', { kind: 'is_a' });
    g.add('dog', 'animal', { kind: 'is_a' });
    expect(g.ancestors('poodle').sort()).toEqual(['animal', 'dog']);
  });

  it('never walks closure through an associative (`related`) edge', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    g.add('birds', 'animal', { kind: 'is_a' });
    g.add('ornithology', 'birds', { kind: 'related' });
    // `related` is a see-also, not a hierarchy. It must not drag `ornithology` into `animal`.
    expect(g.ancestors('ornithology')).not.toContain('animal');
  });
});

describe('a node appearing twice in one tree', () => {
  it('emits one row per PATH, each with a distinct pathKey but the same nodeId', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper', 'reading');
    g.add('reading', 'research');
    g.add('reading', 'leisure');

    const rows = g.tree({ expandAll: true });
    const readingRows = rows.filter((r) => r.nodeId === 'reading');

    expect(readingRows).toHaveLength(2); // it genuinely appears twice
    expect(new Set(readingRows.map((r) => r.pathKey)).size).toBe(2); // distinct view identity
    expect(new Set(readingRows.map((r) => r.nodeId)).size).toBe(1); // one model identity
  });

  it('expands independently in each place (expansion is keyed by pathKey)', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper', 'reading');
    g.add('reading', 'research');
    g.add('reading', 'leisure');

    const rows = g.tree({ expandAll: true });
    const first = rows.find((r) => r.nodeId === 'reading' && r.path.includes(nodeId('research')))!;

    // Open ONLY the appearance under 'research' (plus the ancestors needed to see it).
    const opened = g.tree({
      expanded: new Set([...expandedForPath(first.path), first.pathKey]),
    });

    // 'paper' shows up under research/reading, but not under leisure/reading.
    const paperRows = opened.filter((r) => r.nodeId === 'paper');
    expect(paperRows).toHaveLength(1);
    expect(paperRows[0]!.path).toContain('research');
  });

  it('finds a row\'s twins elsewhere, for cross-highlighting', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper', 'reading');
    g.add('reading', 'research');
    g.add('reading', 'leisure');

    const rows = g.tree({ expandAll: true });
    const row = rows.find((r) => r.nodeId === 'reading')!;
    const twins = twinsOf(rows, row);

    expect(twins).toHaveLength(1);
    expect(twins[0]!.nodeId).toBe('reading');
    expect(twins[0]!.pathKey).not.toBe(row.pathKey);
  });

  it('tells the renderer how many other groups a node is in', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('reading', 'research');
    g.add('reading', 'leisure');

    const rows = g.tree({ expandAll: true });
    const readingRow = rows.find((r) => r.nodeId === 'reading')!;
    // "also in 1 other group" — the semantic channel ARIA leaves open.
    expect(readingRow.otherParentCount).toBe(1);
  });
});

describe('"what other groups is this item in?" — the affordance a tree cannot have', () => {
  it('lists the other groups, excluding the one you are viewing it in', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-1', 'urgent');
    g.add('msg-1', 'q3');

    const others = g.otherLocations('msg-1', 'work');
    expect(others.map((o) => o.group).sort()).toEqual(['q3', 'urgent']);
  });
});

describe('remove ≠ delete', () => {
  it('removing from one group leaves the item in its others', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-1', 'urgent');

    g.remove('msg-1', 'work');
    expect(g.parents('msg-1')).toEqual(['urgent']);
    expect(g.space.nodes.has(nodeId('msg-1'))).toBe(true); // still exists
  });

  it('deleting removes it from every group', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-1', 'urgent');

    g.destroy('msg-1');
    expect(g.space.nodes.has(nodeId('msg-1'))).toBe(false);
    expect(g.members('work')).toEqual([]);
  });

  it('surfaces an item that has fallen out of every group (Zotero\'s Unfiled)', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-2', 'work');
    g.remove('msg-1', 'work');

    expect(g.orphans()).toEqual([nodeId('msg-1')]);
  });
});

describe('move vs add — the most dangerous interaction', () => {
  it('add gives the node a SECOND parent; move relocates it', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('doc', 'inbox');

    g.add('doc', 'archive'); // ADD (the safe default)
    expect(g.parents('doc').sort()).toEqual(['archive', 'inbox']);

    g.move('doc', 'inbox', 'done'); // MOVE (destructive — needs a modifier in the UI)
    expect(g.parents('doc').sort()).toEqual(['archive', 'done']);
  });
});

describe('undo is free, because every write is a delta', () => {
  it('undoes an add', () => {
    const g = defineGroups();
    g.add('a', 'g');
    expect(g.parents('a')).toEqual(['g']);

    expect(g.undo()).toBe(true);
    expect(g.parents('a')).toEqual([]);
  });

  it('undoes a move, restoring the original parent', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('doc', 'inbox');
    g.move('doc', 'inbox', 'archive');
    expect(g.parents('doc')).toEqual(['archive']);

    g.undo();
    expect(g.parents('doc')).toEqual(['inbox']);
  });
});

describe('the groups view and the tags view are the same relation', () => {
  it('a write through either is immediately visible in the other — no conversion step', () => {
    const g = defineGroups({ profile: 'flatTags' });
    g.add('obj1', 'favorites');

    // The "groups" view: favorites → [obj1]
    expect(g.members('favorites')).toEqual(['obj1']);
    // The "tags" view: obj1 → [favorites]
    expect(g.parents('obj1')).toEqual(['favorites']);

    g.add('obj2', 'favorites');

    // Both views updated. There was never anything to keep in sync: one relation, two indexes.
    expect(g.members('favorites').sort()).toEqual(['obj1', 'obj2']);
    expect(g.parents('obj2')).toEqual(['favorites']);
  });
});
