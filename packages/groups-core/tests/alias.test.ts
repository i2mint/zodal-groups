/**
 * `alias_of` (#43): Hydrus siblings, a built-in kind. Declared by an edge, resolved by the
 * facade (`resolveAlias`), never by `applyDelta`; closure never follows it.
 */

import { describe, expect, it } from 'vitest';
import { ancestors, applyDelta, countIn, inferProfile, isGroup, membersOf, createGroupSpace, edgeId, makeEdge, nodeId, resolveAlias, type Edge } from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, kind: string) => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}:${kind}`), kind });
const space = (...edges: Edge[]) => createGroupSpace({ profile: 'thesaurus', edges });
const codes = (r: ReturnType<typeof applyDelta>) => (r.ok ? [] : r.violations.map((v) => v.code));

describe('alias_of', () => {
  it('resolves an alias, and a chain, to the canonical name; a non-alias to itself', () => {
    const s = space(e('todo', 'to-do', 'alias_of'), e('to-do', 'TODO', 'alias_of'));
    expect(resolveAlias(s, n('to-do'))).toBe('todo');
    expect(resolveAlias(s, n('TODO'))).toBe('todo');
    expect(resolveAlias(s, n('todo'))).toBe('todo');
    expect(resolveAlias(s, n('unknown'))).toBe('unknown');
  });

  it('an alias names one canonical node', () => {
    const s = space(e('todo', 'to-do', 'alias_of'));
    expect(codes(applyDelta(s, { added: [e('task', 'to-do', 'alias_of')] }))).toContain('maxPerChild');
  });

  it('is not membership and closure never follows it', () => {
    const s = space(e('todo', 'to-do', 'alias_of'), e('work', 'todo', 'contains'));
    expect([...ancestors(s, n('to-do'))]).toEqual([]);
    expect(isGroup(s, n('todo'))).toBe(false); // its only edge out is an alias, not a membership
    const tagged = space(e('todo', 'to-do', 'alias_of'), e('todo', 'a', 'contains'));
    expect(membersOf(tagged, n('todo'))).toEqual(['a']);
    expect(countIn(tagged, n('todo'))).toBe(1);
  });

  it('is acyclic, and never combined with a hierarchical link between the same nodes', () => {
    const s = space(e('todo', 'to-do', 'alias_of'));
    expect(codes(applyDelta(s, { added: [e('to-do', 'todo', 'alias_of')] }))).toContain('cycle');
    expect(codes(applyDelta(s, { added: [e('todo', 'to-do', 'contains')] }))).toContain('disjointEdgeKind');
  });

  it('works in flat tags (Hydrus siblings are flat), and does not make a space a thesaurus', () => {
    const s = createGroupSpace({ profile: 'flatTags', edges: [e('todo', 'to-do', 'alias_of'), e('todo', 'photo', 'contains')] });
    expect(resolveAlias(s, n('to-do'))).toBe('todo');
    const poly = createGroupSpace({ profile: 'polyhierarchy', edges: [e('todo', 'to-do', 'alias_of'), e('work', 'todo', 'contains'), e('todo', 'x', 'contains')] });
    expect(inferProfile(poly).profile.name).not.toBe('thesaurus');
  });
});
