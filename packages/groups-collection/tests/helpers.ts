/**
 * Test fixtures: item providers (plain and with injectable failures), the three edge backings an
 * operation is tested over (embedded field, memory GroupStore, fs GroupStore in a temp dir), and a
 * `state()` snapshot that makes "the inverse restores exactly" a single `toEqual`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryGroupStore, type GroupProfile, type GroupStore, type ProfileName } from '@zodal/groups-core';
import { createFsGroupStore } from '@zodal/groups-store-fs';
import { createInMemoryProvider, type DataProvider } from '@zodal/store';
import type { SpaceConfig, TaggedCollection } from '../src/index.js';

export type Item = { id: string; title: string; tags?: unknown[]; folders?: unknown[] } & Record<string, unknown>;

export const items = (): Item[] => [
  { id: 'a', title: 'Alpha', tags: ['work'] },
  { id: 'b', title: 'Beta', tags: ['work', 'urgent'] },
  { id: 'c', title: 'Gamma', tags: [] },
  { id: 'd', title: 'Delta' },
];

/** A provider whose writes can be made to fail, per method and id. */
export function flakyProvider<T extends Record<string, unknown>>(data: T[]) {
  const inner = createInMemoryProvider(data);
  const failing = { update: new Set<string>(), create: new Set<string>(), delete: new Set<string>() };
  const calls = { update: [] as string[], create: [] as string[], delete: [] as string[] };
  const provider: DataProvider<T> = {
    ...inner,
    async update(id, patch) {
      calls.update.push(id);
      if (failing.update.has(id)) throw new Error(`disk full while writing ${id}`);
      return inner.update(id, patch);
    },
    async create(record) {
      const id = String((record as Record<string, unknown>).id);
      calls.create.push(id);
      if (failing.create.has(id)) throw new Error(`cannot create ${id}`);
      return inner.create(record);
    },
    async delete(id) {
      calls.delete.push(id);
      if (failing.delete.has(id)) throw new Error(`cannot delete ${id}`);
      return inner.delete(id);
    },
  };
  return { provider, failing, calls };
}

/** One way of keeping a space's edges, set up and torn down per test. */
export interface Backing {
  readonly name: 'embedded' | 'memory store' | 'fs store';
  /** A space config over `field` (embedded) or a fresh store seeded from the items' `field`. */
  space(options: { profile?: ProfileName | GroupProfile; field?: string; seed?: Item[] }): Promise<SpaceConfig>;
  /** A second store instance on the same backing as the last `space()` (for two-writer tests). */
  sibling(): GroupStore;
  dispose(): Promise<void>;
}

/** Seed a store from the items' field, so every backing starts from the same memberships. */
async function seedStore(store: GroupStore, seed: Item[] | undefined, field: string): Promise<void> {
  const added = (seed ?? []).flatMap((it) =>
    ((it[field] as string[] | undefined) ?? []).map((g) => ({ id: `seed:${g}>${it.id}`, parent: g, child: it.id, kind: 'contains' })),
  );
  if (added.length) {
    const r = await store.apply({ added } as never);
    if (!r.ok) throw new Error(`seed refused: ${r.violations.map((v) => v.message).join('; ')}`);
  }
}

export const BACKINGS: ReadonlyArray<{ readonly name: Backing['name']; readonly make: () => Promise<Backing> }> = [
  { name: 'embedded', make: async () => ({
    name: 'embedded',
    space: async ({ profile, field = 'tags' }) => ({ ...(profile ? { profile } : {}), edges: { embedded: field } }),
    sibling: () => {
      throw new Error('embedded spaces have no store');
    },
    dispose: async () => undefined,
  }) },
  { name: 'memory store', make: async () => {
    let last: GroupStore | undefined;
    return {
      name: 'memory store',
      space: async ({ profile = 'polyhierarchy', field = 'tags', seed }) => {
        last = createMemoryGroupStore({ profile });
        await seedStore(last, seed, field);
        return { edges: last };
      },
      sibling: () => {
        // A memory store's backing is its instance: the sibling is the same store object.
        if (!last) throw new Error('no store yet');
        return last;
      },
      dispose: async () => undefined,
    };
  } },
  { name: 'fs store', make: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'groups-collection-'));
    let path = '';
    let profileUsed: ProfileName | GroupProfile = 'polyhierarchy';
    let n = 0;
    return {
      name: 'fs store',
      space: async ({ profile = 'polyhierarchy', field = 'tags', seed }) => {
        path = join(dir, `space-${n++}.json`);
        profileUsed = profile;
        const store = createFsGroupStore({ path, profile });
        await seedStore(store, seed, field);
        return { edges: store };
      },
      sibling: () => createFsGroupStore({ path, profile: profileUsed }),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } },
];

/** Everything observable: the records and every space's nodes and edges (revisions aside). */
export async function state<T extends Record<string, unknown>>(tc: TaggedCollection<T>) {
  await tc.load();
  const { data } = await tc.provider.getList({});
  const records = [...data].sort((x, y) => String(x[tc.idField]).localeCompare(String(y[tc.idField])));
  const spaces: Record<string, unknown> = {};
  for (const name of tc.spaceNames) {
    const s = tc.space(name);
    spaces[name] = {
      nodes: [...s.nodes.values()].map((x) => ({ ...x })).sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...s.edges.values()].map((x) => ({ ...x })).sort((x, y) => x.id.localeCompare(y.id)),
    };
  }
  return { records: JSON.parse(JSON.stringify(records)), spaces };
}

/** The groups an item is directly in, in a space (sorted). */
export function groupsOf<T extends Record<string, unknown>>(tc: TaggedCollection<T>, id: string, space?: string): string[] {
  const s = tc.space(space);
  return [...(s.inverse.get(id as never) ?? [])].map((e) => s.edges.get(e)!.parent as string).sort();
}

/** A store that delegates to `inner`, with `apply` interceptable (I/O errors, forced conflicts) and counted. */
export function interceptStore(
  inner: GroupStore,
  intercept: (call: number, ...args: Parameters<GroupStore['apply']>) => ReturnType<GroupStore['apply']> | undefined = () => undefined,
): GroupStore & { applies: number } {
  const wrapped = {
    applies: 0,
    get profile() {
      return inner.profile;
    },
    load: () => inner.load(),
    getCapabilities: () => inner.getCapabilities(),
    apply(delta: Parameters<GroupStore['apply']>[0], options?: Parameters<GroupStore['apply']>[1]) {
      wrapped.applies += 1;
      return intercept(wrapped.applies, delta, options) ?? inner.apply(delta, options);
    },
  };
  return wrapped;
}
