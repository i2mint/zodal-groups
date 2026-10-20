/**
 * Projections judge structure by membership (#53, D35): an `alias_of` or `related` edge is no parent
 * and opens to nothing, membership kinds are walked (transitive or not), and an alias that only names
 * another node is left out.
 */

import { describe, expect, it } from 'vitest';
import {
  createGroupSpace,
  edgeId,
  facetPanel,
  isAliasName,
  makeEdge,
  nodeId,
  orphansOf,
  projectColumns,
  projectTree,
  rootsOf,
  unfiled,
  type Edge,
} from '../src/index.js';

const n = nodeId;
const e = (parent: string, child: string, kind: string) => makeEdge(n(parent), n(child), { id: edgeId(`${parent}>${child}:${kind}`), kind });
const space = (...edges: Edge[]) => createGroupSpace({ profile: 'thesaurus', edges });
const ids = (rows: readonly { nodeId: string }[]) => rows.map((r) => r.nodeId).sort();

describe('projections and non-membership edges', () => {
  it('an alias that still has members is a root, and its members are reachable', () => {
    // `to-do alias_of todo`, written after `to-do contains a`: neither may vanish.
    const s = space(e('to-do', 'a', 'contains'), e('todo', 'to-do', 'alias_of'), e('todo', 'b', 'contains'));
    expect(isAliasName(s, n('to-do'))).toBe(false); // it has a member: a group, still shown
    expect(rootsOf(s).sort()).toEqual(['to-do', 'todo']);
    expect(ids(projectTree(s))).toEqual(['to-do', 'todo']);
    expect(ids(projectColumns(s)[0]!.rows)).toEqual(['to-do', 'todo']);
    expect(facetPanel(s).map((f) => f.group).sort()).toEqual(['to-do', 'todo']);
  });

  it('a pure alias is left out of roots, orphans and every projection', () => {
    const s = space(e('todo', 'to-do', 'alias_of'), e('work', 'todo', 'contains'), e('todo', 'a', 'contains'));
    expect(isAliasName(s, n('to-do'))).toBe(true);
    expect(rootsOf(s)).toEqual(['work']);
    expect(orphansOf(s)).toEqual([]);
    expect(ids(projectColumns(s, { trail: [n('work')] })[1]!.rows)).toEqual(['todo']);
  });

  it('a canonical tag whose only edge out is an alias is unfiled, with no expander', () => {
    const s = space(e('todo', 'to-do', 'alias_of'));
    expect(orphansOf(s)).toEqual(['todo']);
    const [row] = projectTree(s);
    expect(row).toMatchObject({ nodeId: 'todo', hasChildren: false, childCount: 0 });
    expect(projectColumns(s)[0]!.rows[0]).toMatchObject({ nodeId: 'todo', hasChildren: false, childCount: 0 });
  });

  it('a related link is no parent and no child', () => {
    const s = space(e('x', 'y', 'related'), e('g', 'a', 'contains'));
    expect(rootsOf(s).sort()).toEqual(['g', 'x', 'y']);
    expect(orphansOf(s).sort()).toEqual(['x', 'y']);
    const columns = projectColumns(s)[0]!.rows;
    expect(columns.find((r) => r.nodeId === 'x')).toMatchObject({ childCount: 0, otherParentCount: 0 });
  });

  it('walks every membership kind: an instance_of class is a group with its instances under it', () => {
    const s = space(e('dog', 'fido', 'instance_of'), e('pets', 'fido', 'contains'));
    expect(ids(projectTree(s, { includeItems: false }))).toEqual(['dog', 'pets']);
    expect(ids(projectColumns(s, { trail: [n('dog')] })[1]!.rows)).toEqual(['fido']);
    const [fido] = projectColumns(s, { trail: [n('dog')] })[1]!.rows;
    expect(fido).toMatchObject({ otherParentCount: 1 });
  });

  it('keeps an alias visible when it has a parent', () => {
    const filed = space(e('todo', 'to-do', 'alias_of'), e('work', 'to-do', 'contains'), e('work', 'x', 'contains'));
    expect(isAliasName(filed, n('to-do'))).toBe(false);
    expect(ids(projectColumns(filed, { trail: [n('work')] })[1]!.rows)).toEqual(['to-do', 'x']);
  });

  it('unfiled agrees with orphansOf', () => {
    const s = space(e('x', 'y', 'related'), e('todo', 'to-do', 'alias_of'), e('g', 'a', 'contains'));
    const rule = unfiled<unknown>(n('unfiled')).rule;
    const flagged = [...s.nodes.keys()].filter((id) => rule({ id } as never, s));
    expect(flagged.sort()).toEqual(orphansOf(s).sort());
  });
});
