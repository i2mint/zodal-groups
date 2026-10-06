/**
 * Spaces: several over one item universe (the Zotero acid test, zgroups_05 §8.3), embedded spaces
 * derived from the records (round-trip load), `scope` as a provider filter, staying in step with
 * records changed behind the collection's back, and configuration errors.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMemoryGroupStore, makeEdge, nodeId, validateProfile } from '@zodal/groups-core';
import { createFsGroupStore } from '@zodal/groups-store-fs';
import { createInMemoryProvider } from '@zodal/store';
import { defineCollection } from '@zodal/core';
import { defineTaggedCollection } from '../src/index.js';
import { groupsOf, items, state, type Item } from './helpers.js';

const n = nodeId;

describe('several spaces over one item universe (Zotero: tags and collections)', () => {
  it('each space is its own group space; create and deleteItem span them; undo restores both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'groups-collection-zotero-'));
    try {
      const provider = createInMemoryProvider(items());
      const tc = defineTaggedCollection<Item>({
        provider,
        spaces: {
          tags: { profile: 'flatTags', edges: { embedded: 'tags' } },
          collections: { edges: createFsGroupStore({ path: join(dir, 'collections.json'), profile: 'polyhierarchy' }) },
          folders: { edges: createMemoryGroupStore({ profile: 'filesystem' }) },
        },
      });
      expect(tc.defaultSpace).toBe('tags');
      const start = await state(tc);

      const steps = [
        await tc.tag(['a', 'b'], 'reading', { space: 'collections' }),
        await tc.tag(['a'], 'inbox', { space: 'folders' }),
        // `work` the tag and `work` the collection are different groups.
        await tc.tag(['c'], 'work', { space: 'collections' }),
      ];
      expect(groupsOf(tc, 'a', 'tags')).toEqual(['work']);
      expect(groupsOf(tc, 'c', 'tags')).toEqual([]);
      expect(groupsOf(tc, 'c', 'collections')).toEqual(['work']);
      // Each space enforces its own profile: a file lives in one folder.
      const second = await tc.tag(['a'], 'archive', { space: 'folders' });
      expect(second.failed[0]!.violations![0]!.code).toBe('maxParentsPerItem');

      const created = await tc.create({ id: 'e', title: 'E' }, { groups: { tags: ['new'], collections: ['reading'], folders: ['inbox'] } });
      expect(created.ok).toBe(true);
      expect(groupsOf(tc, 'e', 'tags')).toEqual(['new']);
      expect(groupsOf(tc, 'e', 'collections')).toEqual(['reading']);
      expect(groupsOf(tc, 'e', 'folders')).toEqual(['inbox']);

      const before = await state(tc);
      const del = await tc.deleteItem('a');
      expect(del.ok).toBe(true);
      for (const space of tc.spaceNames) expect(groupsOf(tc, 'a', space)).toEqual([]);
      expect((await tc.revert(del.inverse)).ok).toBe(true);
      expect(await state(tc)).toEqual(before);

      // Undo everything, newest first: back to the start, in all three spaces.
      for (const step of [...steps, created].reverse()) expect((await tc.revert(step.inverse)).ok).toBe(true);
      expect(await state(tc)).toEqual(start);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('embedded spaces are derived from the records', () => {
  it('round-trip: a fresh collection over the same provider loads exactly the live state', async () => {
    const provider = createInMemoryProvider(items());
    const vocabulary = { nodes: [{ id: n('work'), label: 'Work' }], edges: [makeEdge(n('areas'), n('work'), { id: 'v:areas>work' as never })] };
    const config = { spaces: { tags: { edges: { embedded: 'tags' }, vocabulary } } } as const;
    const tc = defineTaggedCollection<Item>({ provider, ...config });
    await tc.tag(['c', 'd'], 'urgent');
    await tc.mergeGroups('urgent', 'later');
    await tc.untag(['a'], 'work');
    await tc.create({ id: 'e', title: 'E' }, { groups: ['work'] });
    await tc.deleteItem('b');
    const live = await state(tc);

    const fresh = defineTaggedCollection<Item>({ provider, ...config });
    expect(await state(fresh)).toEqual(live);
    expect(fresh.space().nodes.get(n('work'))?.label).toBe('Work'); // the vocabulary's fields win
  });

  it('every record is a node, so untagged items are listed as unfiled', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: { embedded: 'tags' } } } });
    await tc.load();
    const s = tc.space();
    expect(['a', 'b', 'c', 'd'].every((id) => s.nodes.has(n(id)))).toBe(true);
  });

  it('loads data that breaks the profile (D8), and validateProfile reports it', async () => {
    const provider = createInMemoryProvider<Item>([{ id: 'a', title: 'A', tags: ['x', 'y'] }]);
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { profile: 'filesystem', edges: { embedded: 'tags' } } } });
    await tc.load();
    expect(groupsOf(tc, 'a')).toEqual(['x', 'y']);
    expect(validateProfile(tc.space()).map((v) => v.code)).toContain('maxParentsPerItem');
  });

  it('entries it does not understand are kept, and the order of the others too', async () => {
    const provider = createInMemoryProvider<Item>([{ id: 'a', title: 'A', tags: ['one', 42, 'two', 'three'] }]);
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    await tc.untag(['a'], 'two');
    expect((await provider.getOne('a')).tags).toEqual(['one', 42, 'three']);
  });

  it('a record changed behind its back is re-read, never overwritten with a stale field', async () => {
    const provider = createInMemoryProvider(items());
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    await tc.load();
    await provider.update('a', { tags: ['work', 'external'] }); // another tab
    await tc.tag(['a'], 'urgent');
    expect((await provider.getOne('a')).tags).toEqual(['work', 'external', 'urgent']);
    expect(groupsOf(tc, 'a')).toEqual(['external', 'urgent', 'work']);
  });

  it('scope(): the items in a group and its subgroups, as a provider filter', async () => {
    const provider = createInMemoryProvider<Item>([
      { id: 'rex', title: 'Rex', tags: ['dogs'] },
      { id: 'tom', title: 'Tom', tags: ['cats'] },
      { id: 'fern', title: 'Fern', tags: ['plants'] },
    ]);
    const tc = defineTaggedCollection<Item>({
      provider,
      spaces: {
        tags: {
          edges: { embedded: 'tags' },
          vocabulary: { edges: [makeEdge(n('animals'), n('dogs'), { id: 'v:1' as never }), makeEdge(n('animals'), n('cats'), { id: 'v:2' as never })] },
        },
      },
    });
    await tc.load();
    const filter = tc.scope('animals');
    expect(filter).toMatchObject({ field: 'tags', operator: 'arrayContainsAny' });
    const { data } = await provider.getList({ filter });
    expect(data.map((d) => d.id).sort()).toEqual(['rex', 'tom']);
    expect(tc.scope('animals', { expand: 'direct' }).value).toEqual(['animals']);
  });
});

describe('configuration', () => {
  const provider = createInMemoryProvider(items());

  it('defaults to one embedded space on a `groups` field (what scopeFilter assumes)', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider<Item>([{ id: 'a', title: 'A' }]) });
    expect(tc.spaceNames).toEqual(['groups']);
    await tc.tag(['a'], 'g');
    expect((await tc.provider.getOne('a')).groups).toEqual(['g']);
  });

  it('takes the id field from a zodal collection, and checks the embedded field against its schema', async () => {
    const schema = z.object({ key: z.string(), title: z.string(), tags: z.array(z.string()) });
    const collection = defineCollection(schema, { idField: 'key' });
    const p = createInMemoryProvider([{ key: 'k1', title: 'K', tags: [] }], { idField: 'key' });
    const tc = defineTaggedCollection({ collection, provider: p, spaces: { tags: { edges: { embedded: 'tags' } } } });
    expect(tc.idField).toBe('key');
    expect((await tc.tag(['k1'], 'x')).ok).toBe(true);
    expect(() => defineTaggedCollection({ collection, provider: p, spaces: { t: { edges: { embedded: 'labels' } } } })).toThrow(/no 'labels' field/);
  });

  it('refuses configurations that cannot work, saying why', () => {
    const store = createMemoryGroupStore({ profile: 'labels' });
    expect(() => defineTaggedCollection({ provider, spaces: {} })).toThrow(/declares no space/);
    expect(() => defineTaggedCollection({ provider, spaces: { a: { edges: { embedded: 'tags' } }, b: { edges: { embedded: 'tags' } } } })).toThrow(/both embed/);
    expect(() => defineTaggedCollection({ provider, spaces: { a: { edges: { embedded: 'id' } } } })).toThrow(/id field/);
    expect(() => defineTaggedCollection({ provider, defaultSpace: 'zz', spaces: { a: { edges: { embedded: 'tags' } } } })).toThrow(/defaultSpace/);
    expect(() => defineTaggedCollection({ provider, spaces: { a: { profile: 'flatTags', edges: store } } })).toThrow(/validates with 'labels'/);
    expect(() =>
      defineTaggedCollection({ provider, spaces: { a: { edges: { embedded: 'tags' }, vocabulary: { edges: [makeEdge(n('x'), n('y'), { id: 'rec:oops' as never })] } } } }),
    ).toThrow(/reserved/);
  });

  it('an unknown space or an impossible kind is a programming error (rejects)', async () => {
    const tc = defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: { embedded: 'tags' } } } });
    await expect(tc.tag(['a'], 'x', { space: 'nope' })).rejects.toThrow(/Unknown space 'nope'. Spaces: tags/);
    await expect(tc.tag(['a'], 'x', { kind: 'is_a' })).rejects.toThrow(/needs a GroupStore/);
    await expect(tc.bulkTag(['a'], { add: ['x'], remove: ['x'] })).rejects.toThrow(/both added and removed/);
    expect(() => defineTaggedCollection<Item>({ provider, spaces: { s: { edges: createMemoryGroupStore() } } }).scope('x')).toThrow(/not loaded|GroupStore/);
  });
});
