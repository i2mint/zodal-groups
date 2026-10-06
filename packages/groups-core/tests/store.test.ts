/**
 * The in-memory `GroupStore` against the shared contract kit — the same cases every
 * `@zodal/groups-store-*` adapter runs — plus what is specific to the memory store.
 */

import { describe, expect, it } from 'vitest';
import { ContractViolation, groupStoreContract } from '../src/testing.js';
import {
  commitDelta,
  invert,
  CLIENT_SIDE_CAPABILITIES,
  createMemoryGroupStore,
  fromSnapshot,
  makeEdge,
  nodeId,
  toSnapshot,
  type GroupStore,
} from '../src/index.js';

const cases = await groupStoreContract({
  make: ({ profile, onListenerError, seed }) =>
    createMemoryGroupStore({ profile, onListenerError, ...(seed ? { snapshot: seed } : {}) }),
});

describe('createMemoryGroupStore: GroupStore contract', () => {
  for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);

  it('skips only the persistence cases, and says why', () => {
    const skipped = cases.filter((c) => c.skip);
    expect(skipped.map((c) => c.name).sort()).toEqual([
      'a refused write leaves the persisted data untouched',
      'a reopened store sees every write, tombstones included',
      'two instances on one backing, writing concurrently, lose nothing',
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
    expect(Object.keys(caps).sort()).toEqual(['closure', 'ordering']);
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
          const inverse = invert(space, delta);
          space = fromSnapshot({ nodes: s.nodes, edges: [...s.edges, ...(delta.added ?? [])], revision: space.revision + 1 }, { profile });
          return { ok: true, value: { revision: space.revision, inverse, epoch: 'e', space } };
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
          const result = commitDelta(base, delta, {}, 'e'); // …write from a stale read: lost updates
          if (result.ok) space = result.value.space;
          return result;
        },
        getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
      } satisfies GroupStore;
    });
    expect(err).toBeInstanceOf(ContractViolation);
  });

  it('a store that computes inverses from a stale read fails the concurrent-inverse case', async () => {
    const err = await runCase(
      'concurrent applies each get the inverse of their own write (exactly one creates the contested node)',
      ({ profile }) => {
        let space = fromSnapshot({ nodes: [], edges: [] }, { profile });
        return {
          profile,
          load: async () => space,
          apply: async (delta) => {
            const stale = space; // read before the serialized section…
            await new Promise((r) => setTimeout(r, 1));
            const result = commitDelta(space, delta, {}, 'e'); // …writes correctly…
            if (!result.ok) return result;
            space = result.value.space;
            return { ok: true, value: { ...result.value, inverse: invert(stale, delta) } }; // …but undoes against the stale read
          },
          getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
        } satisfies GroupStore;
      },
    );
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
