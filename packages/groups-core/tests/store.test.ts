/**
 * The in-memory `GroupStore` against the shared contract kit — the same cases every
 * `@zodal/groups-store-*` adapter runs — plus what is specific to the memory store.
 */

import { describe, expect, it } from 'vitest';
import { ContractViolation, groupStoreContract } from '../src/testing.js';
import {
  applyDelta,
  CLIENT_SIDE_CAPABILITIES,
  createMemoryGroupStore,
  fromSnapshot,
  makeEdge,
  nodeId,
  toSnapshot,
  type GroupStore,
} from '../src/index.js';

const cases = await groupStoreContract({
  make: ({ profile, onListenerError }) => createMemoryGroupStore({ profile, onListenerError }),
});

describe('createMemoryGroupStore: GroupStore contract', () => {
  for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);

  it('skips only the persistence cases, and says why', () => {
    const skipped = cases.filter((c) => c.skip);
    expect(skipped.map((c) => c.name)).toEqual([
      'a reopened store sees every write, tombstones included',
      'a refused write leaves the persisted data untouched',
    ]);
    for (const c of skipped) expect(c.skip).toMatch(/not persistent/);
  });
});

describe('createMemoryGroupStore', () => {
  it('validates seed data against the profile', () => {
    const n = nodeId;
    expect(() =>
      createMemoryGroupStore({
        profile: 'filesystem',
        edges: [makeEdge(n('a'), n('x')), makeEdge(n('b'), n('x'))],
      }),
    ).toThrow(/maxParentsPerItem/);
  });

  it('reports client-side, exact closure and no server facet counts', () => {
    const caps = createMemoryGroupStore().getCapabilities();
    expect(caps.closure).toEqual({ read: 'client', maintainedOnInsert: true, maintainedOnDelete: 'exact' });
    expect(caps.serverFacetCounts).toBe(false);
  });

  it('routes a throwing listener to onListenerError', async () => {
    const errors: unknown[] = [];
    const store = createMemoryGroupStore({ onListenerError: (e) => errors.push(e) });
    store.subscribe!(() => {
      throw new Error('boom');
    });
    const result = await store.apply({ added: [makeEdge(nodeId('g'), nodeId('i'))] });
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('the contract kit catches a store that breaks the contract', () => {
  /** Run one named case against a store factory; resolve to the error it throws (or undefined). */
  const runCase = async (name: string, make: Parameters<typeof groupStoreContract>[0]['make']) => {
    const all = await groupStoreContract({ make });
    const c = all.find((x) => x.name === name);
    if (!c) throw new Error(`no case named ${name}`);
    try {
      await c.run();
      return undefined;
    } catch (e) {
      return e as Error;
    }
  };

  it('a store that writes without validating fails the cycle case', async () => {
    const err = await runCase('a cycle is refused with the offending path, and nothing is written', ({ profile }) => {
      let space = fromSnapshot({ nodes: [], edges: [] }, { profile });
      return {
        profile,
        load: async () => space,
        apply: async (delta) => {
          const s = toSnapshot(space);
          space = fromSnapshot({ nodes: s.nodes, edges: [...s.edges, ...(delta.added ?? [])] }, { profile });
          return { ok: true, value: space };
        },
        getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
      } satisfies GroupStore;
    });
    expect(err).toBeInstanceOf(ContractViolation);
    expect(err!.message).toMatch(/cycle/);
  });

  it("a store that claims native closure without serving it fails the honesty case", async () => {
    const err = await runCase('closure capability is honest', ({ profile }) => {
      const inner = createMemoryGroupStore({ profile });
      return {
        ...inner,
        profile,
        getCapabilities: () => ({ ...CLIENT_SIDE_CAPABILITIES, closure: { ...CLIENT_SIDE_CAPABILITIES.closure, read: 'native' } }),
      };
    });
    expect(err).toBeInstanceOf(ContractViolation);
    expect(err!.message).toMatch(/no closureIds/);
  });

  it('a store that loses concurrent writes fails the concurrency case', async () => {
    const err = await runCase('concurrent applies are serialized: none is lost', ({ profile }) => {
      let space = fromSnapshot({ nodes: [], edges: [] }, { profile });
      return {
        profile,
        load: async () => space,
        apply: async (delta) => {
          const base = space; // read…
          await new Promise((r) => setTimeout(r, 1)); // …yield…
          const result = applyDelta(base, delta); // …write from a stale read: lost updates
          if (result.ok) space = result.value;
          return result;
        },
        getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
      } satisfies GroupStore;
    });
    expect(err).toBeInstanceOf(ContractViolation);
  });

  it('a skip is reported with its reason', async () => {
    const all = await groupStoreContract({
      make: ({ profile }) => createMemoryGroupStore({ profile }),
      skip: { 'capabilities are well-formed': 'documented deviation' },
    });
    expect(all.find((c) => c.name === 'capabilities are well-formed')!.skip).toBe('documented deviation');
  });
});
