/**
 * `inferProfile` (reconciliation D27): the tightest profile a space satisfies, with evidence.
 */

import { describe, expect, it } from 'vitest';
import {
  createGroupSpace,
  edgeId,
  fromSnapshot,
  inferProfile,
  makeEdge,
  nodeId,
  resolveProfile,
  type Edge,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, init: Partial<Omit<Edge, 'parent' | 'child'>> = {}) =>
  makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}`), ...init });
/** Build without validation (the data may come from anywhere). */
const space = (...edges: Edge[]) => fromSnapshot({ nodes: [], edges });

describe('inferProfile picks the tightest fitting profile', () => {
  it('folders: single-homed items, nested single-parent folders → filesystem', () => {
    const r = inferProfile(space(e('docs', 'projects'), e('projects', 'a.txt'), e('docs', 'b.txt')));
    expect(r.profile.name).toBe('filesystem');
    expect(r.violations).toEqual([]);
    expect(r.evidence.observed).toMatchObject({ maxParentsPerItem: 1, maxParentsPerGroup: 1, maxDepth: 1 });
  });

  it('flat, multi-tagged → flatTags, and says why filesystem was rejected', () => {
    const r = inferProfile(space(e('holiday', 'photo'), e('family', 'photo'), e('holiday', 'video')));
    expect(r.profile.name).toBe('flatTags');
    expect(r.evidence.rejected.filesystem).toMatch(/photo would have 2 parents/);
    expect(r.evidence.satisfied).toEqual(expect.arrayContaining(['flatTags', 'nestedTags', 'labels', 'polyhierarchy']));
  });

  it('flat and also per-user (every edge asserted by someone) → folksonomy', () => {
    const by = (who: string) => ({ meta: { assertedBy: who } });
    const r = inferProfile(space(e('cute', 'cat', by('ann')), e('funny', 'cat', by('bob'))));
    expect(r.profile.name).toBe('folksonomy');
    expect(r.evidence.equivalent).toContain('flatTags');
  });

  it('a label tree with multi-labelled items → nestedTags, with labels as its equivalent', () => {
    const r = inferProfile(space(e('work', 'clients'), e('clients', 'msg-1'), e('urgent', 'msg-1')));
    expect(r.profile.name).toBe('nestedTags');
    expect(r.evidence.equivalent).toEqual(['labels']);
  });

  it('a group with two parents → polyhierarchy', () => {
    const r = inferProfile(space(e('research', 'reading'), e('leisure', 'reading'), e('reading', 'paper')));
    expect(r.profile.name).toBe('polyhierarchy');
    expect(r.evidence.rejected.labels).toMatch(/reading would have 2 parents/);
  });

  it('typed edge kinds on a polyhierarchy → thesaurus', () => {
    const r = inferProfile(
      space(e('dog', 'poodle', { kind: 'is_a' }), e('pet', 'poodle', { kind: 'is_a' }), e('poodle', 'rex', { kind: 'instance_of' })),
    );
    expect(r.profile.name).toBe('thesaurus');
    expect(r.evidence.observed.edgeKinds).toEqual({ is_a: 2, instance_of: 1 });
  });

  it('lists an incomparable fitting profile as an alternative', () => {
    // One level, single-homed: both a filesystem and flat tags; neither is tighter.
    const r = inferProfile(space(e('a', 'x'), e('b', 'y')));
    expect(r.profile.name).toBe('filesystem');
    expect(r.evidence.alternatives).toContain('flatTags');
  });
});

describe('when nothing fits', () => {
  it('a cycle from a foreign source → the closest profile, with the cycle as its violation', () => {
    const r = inferProfile(space(e('a', 'b'), e('b', 'c'), e('c', 'a')));
    expect(r.evidence.satisfied).toEqual([]);
    expect(r.violations.map((v) => v.code)).toContain('cycle');
    expect(r.profile.name).toBe('polyhierarchy');
  });

  it('a broken family rule fails every profile and is reported', () => {
    const s = fromSnapshot({
      nodes: [{ id: n('status'), family: { maxPerItem: 1 } }],
      edges: [e('status', 'todo'), e('status', 'done'), e('todo', 't'), e('done', 't')],
    });
    const r = inferProfile(s);
    expect(r.violations.map((v) => v.code)).toEqual(['maxPerFamily']);
  });
});

describe('options', () => {
  it('chooses among custom candidates', () => {
    const tight = resolveProfile('polyhierarchy', { maxGroupsPerItem: 2 });
    const named = { ...tight, name: 'twoTagsMax' };
    const r = inferProfile(space(e('a', 'x'), e('b', 'x')), { candidates: ['polyhierarchy', named] });
    expect(r.profile.name).toBe('twoTagsMax');
  });

  it('measures an empty space without throwing', () => {
    const r = inferProfile(createGroupSpace());
    expect(r.violations).toEqual([]);
    expect(r.evidence.observed.edges).toBe(0);
  });

  it('refuses an empty candidate list', () => {
    expect(() => inferProfile(createGroupSpace(), { candidates: [] })).toThrow(/empty/);
  });
});
