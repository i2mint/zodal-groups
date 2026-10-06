/**
 * A node becomes a group when it gets its first member — and at that moment its existing
 * memberships turn into group-in-group nesting. They must then satisfy the group rules, or a
 * profile can be broken in two innocent-looking steps (tag `holiday` with `travel`; then tag a photo
 * with `holiday`: under `flatTags`, that is a tag inside a tag).
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, validateProfile } from '../src/index.js';

describe('a node that becomes a group is held to the group rules', () => {
  it('flatTags: a tagged tag cannot then receive members', () => {
    const g = defineGroups({ profile: 'flatTags' });
    expect(g.add('holiday', 'travel').ok).toBe(true); // holiday is still an item here
    const r = g.add('photo', 'holiday'); // ...and would now be a group inside `travel`
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('groupsMayContainGroups');
    expect(validateProfile(g.space)).toEqual([]);
  });

  it('labels: an item in two labels cannot become a label (labels form a tree)', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('x', 'p1');
    g.add('x', 'p2'); // fine for an item
    const r = g.add('item', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('maxParentsPerGroup');
  });

  it('maxDepth: becoming a group deepens the nesting above it', () => {
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { maxDepth: 1 } });
    g.add('i', 'a');
    expect(g.add('a', 'b').ok).toBe(true); // depth 1: a inside b
    expect(g.add('c', 'a').ok).toBe(true); // c is an item in a: no deeper
    const r = g.add('i2', 'c'); // c becomes a group: b ⊃ a ⊃ c is depth 2
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('maxDepth');
  });

  it('reports the problem once, not once per new member, inside one delta', () => {
    const g = defineGroups({ profile: 'flatTags' });
    g.add('holiday', 'travel');
    const r = g.apply({
      added: [
        { id: 'h1' as never, parent: 'holiday' as never, child: 'p1' as never, kind: 'contains' },
        { id: 'h2' as never, parent: 'holiday' as never, child: 'p2' as never, kind: 'contains' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.filter((v) => v.code === 'groupsMayContainGroups')).toHaveLength(1);
  });

  it('still lets a fresh, parentless node become a group', () => {
    const g = defineGroups({ profile: 'flatTags' });
    expect(g.add('photo', 'holiday').ok).toBe(true);
    expect(g.add('video', 'holiday').ok).toBe(true);
  });
});

describe('only membership (non-associative) kinds make a node a group (S2)', () => {
  const rel = (parent: string, child: string) => ({ id: `${parent}~${child}` as never, parent: parent as never, child: child as never, kind: 'related' });

  it('labels: a related link to a group is not a second parent', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('x', 'm2');
    g.add('m2', 'p'); // m2 is a label with one parent
    const r = g.apply({ added: [rel('m', 'm2')] });
    expect(r.ok).toBe(true);
  });

  it('flatTags: a related link between two tags is not nesting', () => {
    const g = defineGroups({ profile: 'flatTags' });
    g.add('photo', 'holiday');
    g.add('photo2', 'travel');
    const r = g.apply({ added: [rel('holiday', 'travel')] });
    expect(r.ok).toBe(true);
  });

  it('a node whose only out-edges are associative is not a group', async () => {
    const { isGroup, nodeId } = await import('../src/index.js');
    const g = defineGroups();
    g.apply({ added: [rel('a', 'b')] });
    expect(isGroup(g.space, nodeId('a'))).toBe(false);
  });
});

describe('a group that loses its last member becomes an item, held to the item rules (S1)', () => {
  const seed = () => {
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { maxParentsPerItem: 1 } });
    const e = (parent: string, child: string) => ({ id: `${parent}>${child}` as never, parent: parent as never, child: child as never, kind: 'contains' });
    expect(g.apply({ added: [e('p1', 'g'), e('p2', 'g'), e('g', 'i')] }).ok).toBe(true); // g is a group: 2 parents fine
    return g;
  };

  it('deleting the last member of a two-parent group is refused, naming the group', () => {
    const g = seed();
    const r = g.destroy('i');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0]!.code).toBe('maxParentsPerItem');
      expect(r.violations[0]!.node).toBe('g');
    }
    expect(validateProfile(g.space)).toEqual([]);
  });

  it('is allowed once the group is down to one parent', () => {
    const g = seed();
    expect(g.remove('g', 'p2').ok).toBe(true);
    expect(g.destroy('i').ok).toBe(true);
    expect(validateProfile(g.space)).toEqual([]);
  });
});

describe('one cause, one violation', () => {
  it('flatTags: nesting a tag reports groupsMayContainGroups only, not also maxDepth', () => {
    const g = defineGroups({ profile: 'flatTags' });
    g.add('photo', 'holiday');
    const r = g.add('holiday', 'travel');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toEqual(['groupsMayContainGroups']);
  });
});

describe('a one-way disjointness can no longer build a state whose undo is blocked', () => {
  it('x disjointWith contains: contains next to x is refused, whichever comes first', () => {
    const kinds = { contains: { transitive: true, acyclic: true }, x: { transitive: false, disjointWith: ['contains'] } };
    const g = defineGroups({ profile: 'polyhierarchy', overrides: { edgeKinds: kinds } });
    expect(g.add('c', 'p', { kind: 'x' }).ok).toBe(true);
    const r = g.add('c', 'p'); // contains declares nothing, but x does: still disjoint
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('disjointEdgeKind');
  });
});
