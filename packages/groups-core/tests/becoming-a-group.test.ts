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
