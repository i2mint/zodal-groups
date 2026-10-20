/** The tagging search resolves aliases on read (#51, D34): typing an alias finds the canonical group, once. */
import { describe, expect, it } from 'vitest';
import { defineGroups, makeEdge, nodeId, edgeId } from '@zodal/groups-core';
import { EMPTY_TAGGING_STATE, setTagQuery, toTaggingView } from '../src/index.js';

const build = () => {
  const g = defineGroups({ profile: 'labels' });
  g.add('a', 'todo');
  g.add('b', 'done');
  const alias = makeEdge(nodeId('todo'), nodeId('to-do'), { id: edgeId('todo>to-do'), kind: 'alias_of' });
  expect(g.apply({ added: [alias] }).ok).toBe(true);
  return g;
};
const view = (g: ReturnType<typeof build>, query: string) =>
  toTaggingView(g, setTagQuery(EMPTY_TAGGING_STATE, query), { selection: ['c'] });

describe('tagging search and aliases', () => {
  it('typing an alias lists the canonical group once, saying which name matched', () => {
    const v = view(build(), 'to-d');
    expect(v.rows.map((r) => [r.group, r.matchedAlias])).toEqual([['todo', 'to-do']]);
  });

  it('a match on the group itself carries no matchedAlias', () => {
    expect(view(build(), 'tod').rows.map((r) => [r.group, r.matchedAlias])).toEqual([['todo', undefined]]);
  });

  it('typing an alias exactly offers no Create', () => {
    expect(view(build(), 'to-do').create).toBeUndefined();
    expect(view(build(), 'todo-list').create).toBeDefined();
  });
});
