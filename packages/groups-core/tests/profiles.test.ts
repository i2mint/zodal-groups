/**
 * The headline claim: one model covers pure hierarchies, flat tagging, nested groups, labels, and
 * the general polyhierarchy — differing only by profile. These tests are that claim, executable.
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, nodeId } from '../src/index.js';

describe('profile: filesystem — an item lives in exactly one place', () => {
  it('accepts the first parent and refuses the second', () => {
    const g = defineGroups({ profile: 'filesystem' });
    expect(g.add('report.pdf', 'documents').ok).toBe(true);

    const second = g.add('report.pdf', 'archive');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.violations[0]!.code).toBe('maxParentsPerItem');
    }
  });

  it('allows folders inside folders', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('projects', 'documents');
    g.add('zodal', 'projects');
    expect(g.ancestors('zodal').sort()).toEqual(['documents', 'projects']);
  });

  it('gives a folder exactly one path, so a breadcrumb is unambiguous', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('projects', 'documents');
    g.add('zodal', 'projects');
    expect(g.paths('zodal')).toHaveLength(1);
    expect(g.path('zodal')!.path).toEqual(['documents', 'projects', 'zodal']);
  });
});

describe('profile: flatTags — many tags per item, but no tagging of tags', () => {
  it('lets an item carry unlimited tags', () => {
    const g = defineGroups({ profile: 'flatTags' });
    expect(g.add('photo.jpg', 'holiday').ok).toBe(true);
    expect(g.add('photo.jpg', 'family').ok).toBe(true);
    expect(g.add('photo.jpg', '2024').ok).toBe(true);
    expect(g.parents('photo.jpg').sort()).toEqual(['2024', 'family', 'holiday']);
  });

  it('refuses to nest one tag inside another', () => {
    const g = defineGroups({ profile: 'flatTags' });
    g.add('photo.jpg', 'holiday'); // 'holiday' is now a group
    g.add('x', 'travel'); // 'travel' is now a group

    const nested = g.add('holiday', 'travel');
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      // Either rule may fire first; both express "flat".
      expect(['groupsMayContainGroups', 'maxDepth']).toContain(nested.violations[0]!.code);
    }
  });
});

describe('profile: labels — Gmail. Items multi-parent; the label tree is a tree.', () => {
  it('puts one message under many labels', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-1', 'urgent');
    expect(g.parents('msg-1').sort()).toEqual(['urgent', 'work']);
  });

  it('allows a label hierarchy but only one parent per label', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work'); // make 'work' a group
    g.add('msg-2', 'clients'); // make 'clients' a group
    g.add('msg-3', 'personal'); // make 'personal' a group

    expect(g.add('clients', 'work').ok).toBe(true);

    const second = g.add('clients', 'personal');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.violations[0]!.code).toBe('maxParentsPerGroup');
  });
});

describe('profile: polyhierarchy — the general case', () => {
  it('lets a GROUP have several parents', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper.pdf', 'reading');
    expect(g.add('reading', 'research').ok).toBe(true);
    expect(g.add('reading', 'leisure').ok).toBe(true);
    expect(g.parents('reading').sort()).toEqual(['leisure', 'research']);
  });

  it('surfaces both routes to the same node', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper.pdf', 'reading');
    g.add('reading', 'research');
    g.add('reading', 'leisure');

    const paths = g.paths('reading').map((p) => p.path.join('/')).sort();
    expect(paths).toEqual(['leisure/reading', 'research/reading']);
  });
});

describe('profile: taxonomy — a classification skeleton, items never attach', () => {
  it('refuses to put a bare item in a group', () => {
    const g = defineGroups({ profile: 'taxonomy' });
    // 'dog' has no children, so it is an item, not a group.
    const result = g.add('dog', 'animal');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]!.code).toBe('groupsMayContainItems');
  });
});

describe('hybrids — the dials the user asked for', () => {
  it('enforces a max GROUP-nesting depth, while still allowing items to be filed', () => {
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { maxDepth: 2 } });

    // Give each group an item, so it is a group rather than a leaf.
    g.add('item', 'g1');
    expect(g.add('g1', 'g2').ok).toBe(true); // nesting depth 1
    expect(g.add('g2', 'g3').ok).toBe(true); // nesting depth 2

    const tooDeep = g.add('g3', 'g4'); // would be depth 3
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.violations[0]!.code).toBe('maxDepth');

    // Filing an item is never "depth" — it works at any nesting level.
    expect(g.add('another', 'g3').ok).toBe(true);
  });

  it('enforces a max number of groups per item', () => {
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { maxGroupsPerItem: 2 } });
    expect(g.add('item', 'g1').ok).toBe(true);
    expect(g.add('item', 'g2').ok).toBe(true);
    const third = g.add('item', 'g3');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.violations[0]!.code).toBe('maxGroupsPerItem');
  });

  it('can forbid groups-of-groups while allowing many groups per item', () => {
    const g = defineGroups({
      profile: 'polyhierarchy',
      overrides: { groupsMayContainGroups: false },
    });
    g.add('i1', 'g1');
    g.add('i2', 'g2');
    expect(g.add('i1', 'g2').ok).toBe(true); // item in two groups: fine
    expect(g.add('g1', 'g2').ok).toBe(false); // group in a group: refused
  });
});

describe('the same edges, different profiles', () => {
  it('is the whole pitch: a filesystem and a tag cloud differ only by a dial', () => {
    const edges = [
      { child: 'photo.jpg', parent: 'holiday' },
      { child: 'photo.jpg', parent: 'family' },
    ];

    const tags = defineGroups({ profile: 'flatTags' });
    for (const e of edges) expect(tags.add(e.child, e.parent).ok).toBe(true);

    const fs = defineGroups({ profile: 'filesystem' });
    expect(fs.add(edges[0]!.child, edges[0]!.parent).ok).toBe(true);
    expect(fs.add(edges[1]!.child, edges[1]!.parent).ok).toBe(false); // the ONLY difference
  });
});
