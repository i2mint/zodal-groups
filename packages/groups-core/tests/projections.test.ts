/**
 * Projections: facets, columns, ordering, lint, smart groups.
 */

import { describe, expect, it } from 'vitest';
import {
  defineGroups,
  initialOrders,
  nodeId,
  orderBetween,
  compareOrder,
  extentOf,
  unfiled,
  multiHomed,
} from '../src/index.js';

describe('faceted browsing', () => {
  /** Two items; a taxonomy where `poodle` is under `dog` is under `animal`. */
  const build = () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('rex', 'poodle');
    g.add('bella', 'poodle');
    g.add('felix', 'cat');
    g.add('poodle', 'dog');
    g.add('dog', 'animal');
    g.add('cat', 'animal');
    return g;
  };

  it('counts an ancestor group over the whole closure — picking `animal` finds a `poodle`', () => {
    const g = build();
    // Hearst: selecting a label means "a disjunction over all the labels beneath it".
    expect(g.count('animal', { expand: 'closure' })).toBe(3);
    expect(g.count('dog', { expand: 'closure' })).toBe(2);
    expect(g.count('animal', { expand: 'direct' })).toBe(0); // nothing is *directly* in `animal`
  });

  it('lists members transitively — Zotero\'s "Show Items from Subcollections" as a flag', () => {
    const g = build();
    expect(g.members('dog', { expand: 'direct' })).toEqual(['poodle']);
    expect(g.members('dog', { expand: 'closure', itemsOnly: true }).sort()).toEqual(['bella', 'rex']);
  });

  it('produces a filter that scopes a store query to a group and its subgroups', () => {
    const g = build();
    const filter = g.scope('animal');

    // No new FilterOperator was needed: `arrayContainsAny` already exists in @zodal/core, and
    // maps to Postgres `&&`, PostgREST `ov`, and Dexie `anyOf`.
    expect(filter.operator).toBe('arrayContainsAny');
    expect(filter.field).toBe('groups');
    expect([...filter.value].sort()).toEqual(['animal', 'cat', 'dog', 'poodle']);
  });

  it('builds a facet panel with de-duplicated counts and no dead ends', () => {
    const g = build();
    const panel = g.facets();
    const animal = panel.find((f) => f.group === 'animal')!;

    expect(animal.count).toBe(3);
    expect(animal.hasChildren).toBe(true);
    // Flamenco's invariant: never offer a facet that leads nowhere.
    expect(panel.every((f) => f.count > 0 || f.selected)).toBe(true);
  });
});

describe('Miller columns — the column stack IS the path', () => {
  it('produces one column per selection, plus the next to choose from', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('rex', 'poodle');
    g.add('poodle', 'dog');
    g.add('dog', 'animal');

    const columns = g.columns({ trail: [nodeId('animal'), nodeId('dog')] });

    expect(columns).toHaveLength(3);
    expect(columns[0]!.rows.map((r) => r.nodeId)).toContain('animal');
    expect(columns[1]!.parent).toBe('animal');
    expect(columns[1]!.rows.map((r) => r.nodeId)).toEqual(['dog']);
    expect(columns[2]!.parent).toBe('dog');
    expect(columns[2]!.rows.map((r) => r.nodeId)).toEqual(['poodle']);
  });

  it('never has to guess which parent you are viewing a shared node under', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('paper', 'reading');
    g.add('reading', 'research');
    g.add('reading', 'leisure');

    // The trail disambiguates: we are looking at `reading` *under leisure*. A tree view would
    // have to invent an answer to this; the column browser never asks the question.
    const columns = g.columns({ trail: [nodeId('leisure'), nodeId('reading')] });
    expect(columns[1]!.parent).toBe('leisure');
    expect(columns[2]!.parent).toBe('reading');
    expect(columns[2]!.rows.map((r) => r.nodeId)).toEqual(['paper']);
  });
});

describe('ordering — a rank lives on the edge, so an item in 3 groups has 3 ranks', () => {
  it('mints a key strictly between two others', () => {
    const a = orderBetween(undefined, undefined);
    const c = orderBetween(a, undefined);
    const b = orderBetween(a, c);

    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('inserts between adjacent keys without moving anything else', () => {
    const [x, y] = initialOrders(2) as [string, string];
    const between = orderBetween(x, y);
    expect(x < between && between < y).toBe(true);
  });

  it('refuses an inverted pair rather than silently producing a broken order', () => {
    expect(() => orderBetween('b', 'a')).toThrow();
  });

  it('compares by byte order, not locale — the quiet corruption bug', () => {
    // 'B' < 'a' by code unit, but localeCompare says otherwise in most locales.
    expect(compareOrder('B', 'a')).toBe(-1);
    expect('B'.localeCompare('a')).toBeGreaterThan(0); // the trap we are avoiding
  });

  it('orders siblings in a group by their edge rank', () => {
    const g = defineGroups({ profile: 'filesystem', overrides: { ordered: true } });
    const [first, second, third] = initialOrders(3) as [string, string, string];
    g.add('c', 'folder', { order: third });
    g.add('a', 'folder', { order: first });
    g.add('b', 'folder', { order: second });

    const rows = g.tree({ expandAll: true }).filter((r) => r.depth === 1);
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('lets the same item sit in different positions in different groups', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    const [first, second] = initialOrders(2) as [string, string];
    g.add('shared', 'g1', { order: first });
    g.add('other', 'g1', { order: second });
    g.add('shared', 'g2', { order: second });
    g.add('other', 'g2', { order: first });

    const g1 = g.tree({ roots: [nodeId('g1')], expandAll: true }).filter((r) => r.depth === 1);
    const g2 = g.tree({ roots: [nodeId('g2')], expandAll: true }).filter((r) => r.depth === 1);

    expect(g1.map((r) => r.nodeId)).toEqual(['shared', 'other']);
    expect(g2.map((r) => r.nodeId)).toEqual(['other', 'shared']); // reversed. Rank is per-edge.
  });
});

describe('per-edge labels — the same item, two names', () => {
  it('renders a different label in each group', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('doc-42', 'work', { label: 'Q3 Report' });
    g.add('doc-42', 'personal', { label: 'that thing I owe Sam' });

    const rows = g.tree({ expandAll: true });
    const labels = rows.filter((r) => r.nodeId === 'doc-42').map((r) => r.label).sort();
    expect(labels).toEqual(['Q3 Report', 'that thing I owe Sam']);
  });
});

describe('smart (intensional) groups', () => {
  it('computes "unfiled" — items in no group at all', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.apply({ upsertNodes: [{ id: nodeId('msg-2') }] }); // exists, but filed nowhere

    const extent = extentOf(g.space, unfiled(nodeId('@unfiled')));
    expect(extent).toEqual([nodeId('msg-2')]);
  });

  it('computes "in multiple groups" — a view only polyhierarchy makes possible', () => {
    const g = defineGroups({ profile: 'labels' });
    g.add('msg-1', 'work');
    g.add('msg-1', 'urgent');
    g.add('msg-2', 'work');

    const extent = extentOf(g.space, multiHomed(nodeId('@shared')));
    expect(extent).toEqual([nodeId('msg-1')]);
  });
});

describe('lint', () => {
  it('flags a redundant shortcut edge that will drift on re-parent', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('poodle', 'dog');
    g.add('dog', 'animal');
    g.add('poodle', 'animal'); // redundant: already implied by the closure

    const lints = g.lint();
    expect(lints.some((l) => l.rule === 'redundantEdge')).toBe(true);
  });

  it('flags a part_of child with several wholes (Z39.19 §8.3.3.2)', () => {
    const g = defineGroups({ profile: 'thesaurus' });
    g.add('wheel', 'car', { kind: 'part_of' });
    g.add('wheel', 'bicycle', { kind: 'part_of' });

    const lints = g.lint();
    expect(lints.some((l) => l.rule === 'multiParentPartitive')).toBe(true);
  });

  it('is clean for a healthy hierarchy', () => {
    const g = defineGroups({ profile: 'polyhierarchy' });
    g.add('rex', 'dog');
    g.add('dog', 'animal');
    expect(g.lint().filter((l) => l.severity === 'error')).toEqual([]);
  });
});

describe('the change stream', () => {
  it('notifies subscribers with the delta and the new revision', () => {
    const g = defineGroups();
    const seen: number[] = [];
    g.subscribe((change) => seen.push(change.revision));

    g.add('a', 'g');
    g.add('b', 'g');

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
  });
});
