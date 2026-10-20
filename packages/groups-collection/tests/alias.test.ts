/**
 * Aliases resolve on write (#43): `tag(ids, 'to-do')` records `todo` when the space says
 * `to-do alias_of todo`. The core never rewrites a delta (D7); the facade does the resolving.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryGroupStore } from '@zodal/groups-core';
import { createInMemoryProvider } from '@zodal/store';
import { defineTaggedCollection } from '../src/index.js';
import { groupsOf, items, type Item } from './helpers.js';

async function setup(extra: { id: string; parent: string; child: string; kind: string }[] = []) {
  const store = createMemoryGroupStore({ profile: 'polyhierarchy' });
  const seeded = await store.apply({
    added: [
      { id: 'todo>a', parent: 'todo', child: 'a', kind: 'contains' },
      { id: 'todo>to-do', parent: 'todo', child: 'to-do', kind: 'alias_of' },
      { id: 'to-do>TODO', parent: 'to-do', child: 'TODO', kind: 'alias_of' },
      ...extra,
    ],
  } as never);
  if (!seeded.ok) throw new Error(seeded.violations.map((v) => v.message).join('; '));
  const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: store } } });
  await tc.load();
  return tc;
}

describe('aliases resolve on write', () => {
  it('tag and untag by an alias (and through a chain) write the canonical group', async () => {
    const tc = await setup();
    expect((await tc.tag(['b'], 'to-do')).ok).toBe(true);
    expect((await tc.tag(['c'], 'TODO')).ok).toBe(true);
    expect(groupsOf(tc, 'b')).toContain('todo');
    expect(groupsOf(tc, 'c')).toContain('todo');
    expect(groupsOf(tc, 'b')).not.toContain('to-do');
    expect((await tc.untag(['a'], 'to-do')).ok).toBe(true);
    expect(groupsOf(tc, 'a')).not.toContain('todo');
  });

  it('bulkTag resolves its add and remove lists', async () => {
    const tc = await setup();
    expect((await tc.bulkTag(['b', 'c'], { add: ['to-do'] })).ok).toBe(true);
    expect(groupsOf(tc, 'b')).toContain('todo');
    expect((await tc.bulkTag(['b'], { remove: ['TODO'] })).ok).toBe(true);
    expect(groupsOf(tc, 'b')).not.toContain('todo');
  });

  it('untag by the alias also removes a membership filed under the alias name itself', async () => {
    // Filed under `TODO` directly (a store written before the alias, or by another tool).
    const tc = await setup([{ id: 'TODO>d', parent: 'TODO', child: 'd', kind: 'contains' }]);
    expect(groupsOf(tc, 'd')).toContain('TODO');
    expect((await tc.untag(['d'], 'TODO')).ok).toBe(true);
    expect(groupsOf(tc, 'd')).not.toContain('TODO');
  });

  it('create takes alias names too', async () => {
    const tc = await setup();
    const r = await tc.create({ id: 'z', title: 'Z' } as Item, { groups: ['to-do'] });
    expect(r.ok).toBe(true);
    expect(groupsOf(tc, 'z')).toEqual(['todo']);
  });
});
