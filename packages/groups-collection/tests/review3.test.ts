/**
 * Regression tests from the third review of PR #7 (the reviewer's zz-v3 probes, made to assert):
 * a provider write that lands and then throws is read back before it is reported (R1, R2), and a
 * read-back that fails is an unknown outcome, flagged (R3).
 */

import { describe, expect, it } from 'vitest';
import { createMemoryGroupStore, nodeId, type GroupStore } from '@zodal/groups-core';
import { createInMemoryProvider, type DataProvider } from '@zodal/store';
import { defineTaggedCollection } from '../src/index.js';
import { groupsOf, items, state, type Item } from './helpers.js';

const storeGroups = async (s: GroupStore, id: string) => {
  const sp = await s.load();
  return [...(sp.inverse.get(nodeId(id)) ?? [])].map((e) => sp.edges.get(e)!.parent as string).sort();
};

/** A provider whose next `method` call lands and then throws. */
function landsThenThrows(method: 'update' | 'create' | 'delete') {
  const inner = createInMemoryProvider(items());
  let armed = false;
  const provider: DataProvider<Item> = {
    ...inner,
    [method]: async (...args: unknown[]) => {
      const out = await (inner[method] as (...a: unknown[]) => Promise<unknown>)(...args);
      if (armed) {
        armed = false;
        throw new Error('timeout');
      }
      return out;
    },
  };
  return { provider, inner, arm: () => (armed = true) };
}

describe('R1/R2 — a provider write that lands and then throws is read back', () => {
  it('R1: an embedded tag whose update landed is a success; record, cache and inverse agree', async () => {
    const { provider, inner, arm } = landsThenThrows('update');
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const start = await state(tc);
    arm();
    const r = await tc.tag(['c'], 'new');
    expect(r.failed).toEqual([]);
    expect(r.succeeded).toEqual(['c']);
    expect((await inner.getOne('c')).tags).toEqual(['new']);
    expect(groupsOf(tc, 'c')).toEqual(['new']);
    expect((await tc.revert(r.inverse)).failed).toEqual([]);
    expect(await state(tc)).toEqual(start);
  });

  it('R2: deleteItem whose record delete landed goes on to remove the edges', async () => {
    const s = createMemoryGroupStore();
    const { provider, inner, arm } = landsThenThrows('delete');
    const tc = defineTaggedCollection<Item>({ provider, spaces: { col: { edges: s } } });
    await tc.tag(['a'], 'g');
    arm();
    const r = await tc.deleteItem('a');
    expect(r.failed).toEqual([]);
    expect(r.succeeded).toEqual(['a']);
    await expect(inner.getOne('a')).rejects.toThrow();
    expect(await storeGroups(s, 'a')).toEqual([]);
    // …and it is undoable like any delete.
    expect((await tc.revert(r.inverse)).failed).toEqual([]);
    expect(await storeGroups(s, 'a')).toEqual(['g']);
    expect(await inner.getOne('a')).toMatchObject({ id: 'a', title: 'Alpha' });
  });

  it('a create that landed and then threw goes on to write its edges', async () => {
    const s = createMemoryGroupStore();
    const { provider, inner, arm } = landsThenThrows('create');
    const tc = defineTaggedCollection<Item>({ provider, spaces: { col: { edges: s } } });
    arm();
    const r = await tc.create({ id: 'z', title: 'Z' }, { groups: ['proj'] });
    expect(r.failed).toEqual([]);
    expect(r.record).toMatchObject({ id: 'z' });
    expect(await inner.getOne('z')).toMatchObject({ id: 'z' });
    expect(await storeGroups(s, 'z')).toEqual(['proj']);
  });

  it('a create without an id that may have landed cannot be found again: failed, inconsistent', async () => {
    const { provider, arm } = landsThenThrows('create');
    const tc = defineTaggedCollection<Item>({ provider, spaces: { col: { edges: createMemoryGroupStore() } } });
    arm();
    const r = await tc.create({ title: 'no id' } as Item, { groups: ['proj'] });
    expect(r.failed[0]).toMatchObject({ code: 'recordWrite', inconsistent: true });
    expect(r.failed[0]!.reason).toMatch(/outcome is unknown/);
  });
});

describe('R3 — a read-back that fails is an unknown outcome', () => {
  /** A provider whose reads (getOne and getList) all fail once `failReads()` was called. */
  function readsFailAfter(update: (inner: DataProvider<Item>, id: string, patch: Partial<Item>, failReads: () => void) => Promise<Item>) {
    const inner = createInMemoryProvider(items());
    let broken = false;
    const failReads = () => (broken = true);
    const provider: DataProvider<Item> = {
      ...inner,
      update: (id, patch) => update(inner, id, patch, failReads),
      async getOne(id) {
        if (broken) throw new Error('read timeout');
        return inner.getOne(id);
      },
      async getList(params) {
        if (broken) throw new Error('read timeout');
        return inner.getList(params);
      },
    };
    return provider;
  }

  it('after a landed update: reported as unknown (not as another writer), and flagged', async () => {
    const provider = readsFailAfter(async (inner, id, patch, failReads) => {
      const out = await inner.update(id, patch);
      failReads();
      return out;
    });
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const r = await tc.tag(['c'], 'new');
    expect(r.failed[0]).toMatchObject({ id: 'c', code: 'recordWrite', inconsistent: true });
    expect(r.failed[0]!.reason).toMatch(/outcome is unknown/);
    expect(r.failed[0]!.reason).not.toMatch(/Another writer/);
  });

  it('after an update that threw: unknown, flagged', async () => {
    const provider = readsFailAfter(async (_inner, _id, _patch, failReads) => {
      failReads();
      throw new Error('timeout');
    });
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    const r = await tc.tag(['c'], 'new');
    expect(r.failed[0]).toMatchObject({ id: 'c', code: 'recordWrite', inconsistent: true });
    expect(r.failed[0]!.reason).toMatch(/outcome is unknown/);
  });

  it('a read-back that fails only on getOne is confirmed by getList: a landed update succeeds', async () => {
    const inner = createInMemoryProvider(items());
    let reads = 0;
    const provider: DataProvider<Item> = {
      ...inner,
      async getOne(id) {
        if (reads && --reads === 0) throw new Error('read timeout');
        return inner.getOne(id);
      },
    };
    const tc = defineTaggedCollection<Item>({ provider, spaces: { tags: { edges: { embedded: 'tags' } } } });
    await tc.load();
    reads = 2; // the 1st getOne is the pre-read, the 2nd the read-back
    const r = await tc.tag(['c'], 'new');
    expect(r.failed).toEqual([]);
    expect(groupsOf(tc, 'c')).toEqual(['new']);
  });
});
