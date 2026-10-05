/**
 * `@zodal/groups-core/testing` — the `GroupStore` conformance kit.
 *
 * Every `@zodal/groups-store-*` adapter runs the same contract: deltas persist and load back with
 * consistent indexes, a cycle is refused *with the offending path* and writes nothing, a refused
 * delta is all-or-nothing, `invert` round-trips through the store (tombstones included), family
 * rules hold, concurrent applies are not lost, and the capability record is honest. The contract is
 * plain data, so it runs under vitest, jest, node:test or a plain script:
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import { groupStoreContract } from '@zodal/groups-core/testing';
 *
 * const cases = await groupStoreContract({
 *   make: ({ profile, backing }) => createMyGroupStore({ profile, location: dirFor(backing) }),
 *   persistent: true,                       // two makes with one `backing` open the same data
 *   dispose: ({ backing }) => removeDir(dirFor(backing)),
 * });
 *
 * describe('my adapter: GroupStore contract', () => {
 *   for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
 * });
 * ```
 *
 * Mirrors `@zodal/store/testing`'s `providerContract`: an async factory, `make` per case (so cases
 * never see each other's writes), `skip` for documented deviations, `dispose` to clean up. Each
 * case's `run` throws a {@link ContractViolation} on failure.
 */

import {
  edgeId,
  nodeId,
  type Edge,
  type EdgeDelta,
  type GroupSpace,
  type Node,
  type NodeId,
  type Result,
} from './model.js';
import { resolveProfile, type GroupProfile, type ProfileName } from './profile.js';
import { deleteNodeDelta, edgesInto, edgesOf, invert, makeEdge } from './space.js';
import { closureIds } from './closure.js';
import type { GroupStore, GroupStoreCapabilities, GroupStoreChange } from './store.js';

/** What `make` is given. */
export interface GroupStoreContext {
  /** The profile the store must validate writes with. */
  readonly profile: GroupProfile;
  /**
   * A case-unique key. With `persistent: true`, two `make` calls with the same `backing` must open
   * the same persisted data (the same file, database, prefix…).
   */
  readonly backing: string;
  /** Pass this to the store's listener-error hook, if it has one, so the kit's throwing listener stays quiet. */
  readonly onListenerError: (error: unknown) => void;
}

export interface GroupStoreContractOptions {
  /** Open an (initially empty, for a new `backing`) store under `ctx.profile`. May be async. */
  readonly make: (ctx: GroupStoreContext) => GroupStore | Promise<GroupStore>;
  /** The store outlives its instance: enables the "reopened store" cases. */
  readonly persistent?: boolean;
  /** Cases to skip, by name, with the reason. A skip is a documented deviation, not a silent one. */
  readonly skip?: Readonly<Record<string, string>>;
  /** Release what `make` created for this `backing`; called once after each case. */
  readonly dispose?: (ctx: { readonly backing: string }) => void | Promise<void>;
}

export interface ContractCase {
  /** Stable, human-readable name (also the key for `options.skip`). */
  readonly name: string;
  /** Throws {@link ContractViolation} when the store breaks the contract. */
  readonly run: () => Promise<void>;
  /** Why this case is skipped. */
  readonly skip?: string;
}

/** Thrown by a contract case: what was expected, and what the store did. */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fail(message: string): never {
  throw new ContractViolation(message);
}

/** Canonical JSON: object keys sorted, so key order (an artefact of how a node was merged) never matters. */
const show = (value: unknown): string => {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  try {
    return JSON.stringify(canonical(value));
  } catch {
    return String(value);
  }
};

/** JSON-normalized, id-sorted nodes and edges: what "the same space" means across a store. */
function normalize(space: GroupSpace): { nodes: unknown[]; edges: unknown[] } {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.parse(
    JSON.stringify({
      nodes: [...space.nodes.values()].sort(byId),
      edges: [...space.edges.values()].sort(byId),
    }),
  );
}

function sameSpace(actual: GroupSpace, expected: GroupSpace, what: string): void {
  const a = show(normalize(actual));
  const e = show(normalize(expected));
  if (a !== e) fail(`${what}: expected ${e}, got ${a}`);
}

function equal(actual: unknown, expected: unknown, what: string): void {
  if (show(actual) !== show(expected)) fail(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

/** `forward`/`inverse` are exactly the indexes of `edges`, and every endpoint is a node. */
function indexesConsistent(space: GroupSpace, what: string): void {
  for (const edge of space.edges.values()) {
    if (!space.forward.get(edge.parent)?.has(edge.id)) fail(`${what}: forward[${edge.parent}] misses edge ${edge.id}`);
    if (!space.inverse.get(edge.child)?.has(edge.id)) fail(`${what}: inverse[${edge.child}] misses edge ${edge.id}`);
    if (!space.nodes.has(edge.parent) || !space.nodes.has(edge.child)) fail(`${what}: edge ${edge.id} has an endpoint that is not a node`);
  }
  for (const [index, side] of [[space.forward, 'parent'], [space.inverse, 'child']] as const) {
    for (const [key, ids] of index) {
      if (!ids.size) fail(`${what}: empty index entry for ${key}`);
      for (const id of ids) {
        const edge = space.edges.get(id);
        if (!edge || edge[side] !== key) fail(`${what}: stale index entry ${key} → ${id}`);
      }
    }
  }
}

function expectOk<T>(result: Result<T>, what: string): T {
  if (!result.ok) fail(`${what}: expected ok, got violations ${show(result.violations.map((v) => `[${v.code}] ${v.message}`))}`);
  return result.value;
}

function expectRefused<T>(result: Result<T>, code: string, what: string) {
  if (result.ok) fail(`${what}: expected a '${code}' violation, but the delta was accepted`);
  const v = result.violations.find((x) => x.code === code);
  if (!v) fail(`${what}: expected a '${code}' violation, got ${show(result.violations.map((x) => x.code))}`);
  return v;
}

/** An edge with a deterministic id, so cases can name it. */
const edge = (parent: string, child: string, init: Partial<Omit<Edge, 'parent' | 'child'>> = {}): Edge =>
  makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`${parent}>${child}`), ...init });

const n = nodeId;

/** A small polyhierarchy: research/reading, archive/research, leisure/reading, plus items. */
const SEED: EdgeDelta = {
  upsertNodes: [
    { id: n('reading'), label: 'Reading', payload: { colour: 'blue' } },
    { id: n('paper.pdf'), label: 'A paper', payload: { pages: 12 } },
  ],
  added: [
    edge('reading', 'paper.pdf'),
    edge('reading', 'notes.md'),
    edge('research', 'reading'),
    edge('leisure', 'reading'),
    edge('archive', 'research'),
    edge('leisure', 'novel.epub'),
  ],
};

// ── the contract ────────────────────────────────────────────────────────────

/**
 * The `GroupStore` contract as a list of independent cases.
 *
 * Async because it opens one probe store to read `getCapabilities()` and to see whether it offers
 * `subscribe`; cases that need something the store honestly says it lacks are skipped with the
 * reason.
 */
export async function groupStoreContract(options: GroupStoreContractOptions): Promise<ContractCase[]> {
  let counter = 0;
  const newBacking = () => `groups-contract-${Date.now().toString(36)}-${(counter += 1)}`;
  const quiet = () => undefined;

  interface Harness {
    /** The case's store (opened once, under `profile`). */
    readonly store: GroupStore;
    /** Open another instance over the same backing (persistent stores only). */
    reopen(): Promise<GroupStore>;
    readonly caps: GroupStoreCapabilities;
    readonly errors: unknown[];
  }
  type Body = (h: Harness) => Promise<void>;
  type Gate = (probe: { caps: GroupStoreCapabilities; subscribes: boolean }) => string | undefined;
  const cases: { name: string; body: Body; profile: ProfileName | GroupProfile; gate?: Gate }[] = [];
  const add = (name: string, body: Body, opts: { profile?: ProfileName | GroupProfile; gate?: Gate } = {}) =>
    cases.push({ name, body, profile: opts.profile ?? 'polyhierarchy', ...(opts.gate ? { gate: opts.gate } : {}) });

  const persistent: Gate = () => (options.persistent ? undefined : 'store is not persistent (options.persistent is not true)');
  const subscribes: Gate = (p) => (p.subscribes ? undefined : 'store has no subscribe (it is optional)');

  const seeded = async (store: GroupStore): Promise<GroupSpace> => expectOk(await store.apply(SEED), 'seed delta');

  // ── loading and writing ───────────────────────────────────────────────────

  add('a new store loads an empty space', async ({ store }) => {
    const space = await store.load();
    equal([space.nodes.size, space.edges.size], [0, 0], '[nodes, edges] of a new store');
  });

  add('apply persists nodes and edges; load returns them with consistent indexes', async ({ store }) => {
    const applied = await seeded(store);
    const loaded = await store.load();
    sameSpace(loaded, applied, 'load() after apply');
    indexesConsistent(loaded, 'load() after apply');
    equal(
      edgesInto(loaded, n('reading')).map((e) => e.parent).sort(),
      ['leisure', 'research'],
      'parents of reading',
    );
    equal(edgesOf(loaded, n('reading')).map((e) => e.child).sort(), ['notes.md', 'paper.pdf'], 'children of reading');
  });

  add('edge removals persist', async ({ store }) => {
    await seeded(store);
    expectOk(await store.apply({ removed: [edgeId('leisure>reading')] }), 'remove leisure>reading');
    const loaded = await store.load();
    if (loaded.edges.has(edgeId('leisure>reading'))) fail('the removed edge is still loaded');
    indexesConsistent(loaded, 'load() after removal');
    equal(edgesInto(loaded, n('reading')).map((e) => e.parent), ['research'], 'parents of reading');
  });

  add('edge kind, label, order and meta round-trip', async ({ store, caps }) => {
    const e = edge('animals', 'dog', {
      kind: 'is_a',
      label: 'Dogs',
      ...(caps.ordering ? { order: 'aZ' } : {}),
      meta: { assertedBy: 'ann', confidence: 0.9 },
    });
    expectOk(await store.apply({ added: [e] }), 'add a decorated edge');
    equal((await store.load()).edges.get(e.id), JSON.parse(JSON.stringify(e)), 'the loaded edge');
  });

  add('node label, payload and family rule round-trip', async ({ store }) => {
    const node: Node = { id: n('status'), label: 'Status', payload: { colour: 'red', tags: ['a', 'b'] }, family: { maxPerItem: 1 } };
    expectOk(await store.apply({ upsertNodes: [node] }), 'upsert a decorated node');
    equal((await store.load()).nodes.get(node.id), node, 'the loaded node');
  });

  add('revision increases on each successful apply and not on a refused one', async ({ store }) => {
    const r0 = (await store.load()).revision;
    const r1 = expectOk(await store.apply({ added: [edge('a', 'b')] }), 'first apply').revision;
    if (!(r1 > r0)) fail(`revision after an apply: expected > ${r0}, got ${r1}`);
    expectRefused(await store.apply({ added: [edge('b', 'a')] }), 'cycle', 'a cyclic delta');
    equal((await store.load()).revision, r1, 'revision after a refused apply');
  });

  // ── invariants on write ───────────────────────────────────────────────────

  add('a cycle is refused with the offending path, and nothing is written', async ({ store }) => {
    const before = await seeded(store);
    // archive ⊃ research ⊃ reading. Putting archive inside reading closes the loop.
    const v = expectRefused(await store.apply({ added: [edge('reading', 'archive')] }), 'cycle', 'reading ⊃ archive');
    const path = v.path ?? fail('the cycle violation has no path');
    if (path[0] !== 'archive' || path[path.length - 1] !== 'reading') {
      fail(`the cycle path must run from the new child (archive) to the new parent (reading), got ${show(path)}`);
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const [a, b] = [path[i]!, path[i + 1]!];
      if (!edgesOf(before, a).some((e) => e.child === b)) fail(`cycle path step ${a} → ${b} is not an existing edge (${show(path)})`);
    }
    sameSpace(await store.load(), before, 'load() after the refused cycle');
  });

  add(
    'a refused delta writes nothing, not even its valid half',
    async ({ store }) => {
      expectOk(await store.apply({ added: [edge('docs', 'report.pdf')] }), 'file report.pdf');
      const before = await store.load();
      const result = await store.apply({
        added: [edge('docs', 'memo.txt'), edge('archive', 'report.pdf')], // 2nd: a second parent
        upsertNodes: [{ id: n('docs'), label: 'Documents' }],
      });
      expectRefused(result, 'maxParentsPerItem', 'a second folder for report.pdf');
      sameSpace(await store.load(), before, 'load() after the refused delta');
    },
    { profile: 'filesystem' },
  );

  add('a family rule is enforced: an exclusive family refuses a second value', async ({ store }) => {
    expectOk(
      await store.apply({
        upsertNodes: [{ id: n('status'), family: { maxPerItem: 1 } }],
        added: [edge('status', 'todo'), edge('status', 'done'), edge('todo', 'task-1')],
      }),
      'an exclusive status family with task-1 in todo',
    );
    const v = expectRefused(await store.apply({ added: [edge('done', 'task-1')] }), 'maxPerFamily', 'task-1 also in done');
    equal(v.family, 'status', 'violation.family');
    equal([...(v.values ?? [])].sort(), ['done', 'todo'], 'violation.values');
    equal(edgesInto(await store.load(), n('task-1')).map((e) => e.parent), ['todo'], 'task-1 parents after the refusal');
  });

  add('a malformed write is refused, and the store still loads', async ({ store }) => {
    const before = await seeded(store);
    expectRefused(
      await store.apply({ upsertNodes: [{ id: n('status'), family: { maxPerItem: 1.5 } }] }),
      'invalidFamilyRule',
      'a fractional family cap',
    );
    expectRefused(await store.apply({ upsertNodes: [{ id: n('x'), label: 5 as never }] }), 'malformed', 'a numeric label');
    sameSpace(await store.load(), before, 'load() after the refused writes');
  });

  add('a tombstone with an edge still attached is refused (danglingEdge)', async ({ store }) => {
    const before = await seeded(store);
    const reading = before.nodes.get(n('reading'))!;
    expectRefused(await store.apply({ removedNodes: [reading] }), 'danglingEdge', 'remove reading, keep its edges');
    sameSpace(await store.load(), before, 'load() after the refused tombstone');
  });

  // ── undo: invert round-trips through the store ────────────────────────────

  add('applying invert(delta) restores the space exactly', async ({ store }) => {
    const before = await seeded(store);
    const delta: EdgeDelta = {
      added: [edge('archive', 'novel.epub'), edge('inbox', 'fresh.txt')], // inbox, fresh.txt are new
      removed: [edgeId('reading>notes.md')],
      upsertNodes: [
        { id: n('reading'), label: 'To read' }, // changed
        { id: n('notes.md'), label: 'Notes' }, // a field it did not have
      ],
    };
    const after = expectOk(await store.apply(delta), 'the delta');
    if (!after.nodes.has(n('inbox'))) fail('the delta should have created node inbox');
    expectOk(await store.apply(invert(before, delta)), 'its inverse');
    sameSpace(await store.load(), before, 'load() after apply + invert');
  });

  add("deleting a group is undone by its tombstone: label, payload and edges come back", async ({ store }) => {
    const before = await seeded(store);
    const del = deleteNodeDelta(before, n('reading'));
    equal(del.removedNodes?.map((x) => x.id), ['reading'], 'deleteNodeDelta tombstones');
    const gone = expectOk(await store.apply(del), 'delete reading');
    if (gone.nodes.has(n('reading'))) fail('reading survived its delete');
    if (edgesInto(gone, n('paper.pdf')).length) fail('paper.pdf is still in a group after reading was deleted');
    expectOk(await store.apply(invert(before, del)), 'undo the delete');
    const restored = await store.load();
    sameSpace(restored, before, 'load() after undoing the delete');
    equal(restored.nodes.get(n('reading')), { id: 'reading', label: 'Reading', payload: { colour: 'blue' } }, 'the restored node');
  });

  add('a merge (re-point edges, then delete) is undone exactly', async ({ store }) => {
    expectOk(
      await store.apply({
        upsertNodes: [{ id: n('todo'), label: 'Todo', payload: { emoji: '☐' } }],
        added: [edge('todo', 'a'), edge('todo', 'b'), edge('to-do', 'b'), edge('to-do', 'c'), edge('work', 'todo')],
      }),
      'seed two spellings of one tag',
    );
    const before = await store.load();
    // Merge `todo` into `to-do`: re-point todo's memberships (skipping one to-do already has), then
    // tombstone todo with every edge that touched it.
    const has = new Set(edgesOf(before, n('to-do')).map((e) => e.child));
    const repointed = edgesOf(before, n('todo'))
      .filter((e) => !has.has(e.child))
      .map((e) => edge('to-do', e.child));
    const del = deleteNodeDelta(before, n('todo'));
    const merge: EdgeDelta = { ...del, added: [...repointed, edge('work', 'to-do')] };
    const merged = expectOk(await store.apply(merge), 'the merge');
    equal(edgesOf(merged, n('to-do')).map((e) => e.child).sort(), ['a', 'b', 'c'], 'to-do after the merge');
    expectOk(await store.apply(invert(before, merge)), 'undo the merge');
    sameSpace(await store.load(), before, 'load() after undoing the merge');
  });

  // ── concurrency ───────────────────────────────────────────────────────────

  add('concurrent applies are serialized: none is lost', async ({ store }) => {
    const count = 25;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) => store.apply({ added: [edge('bucket', `item-${i}`)] })),
    );
    const revisions = results.map((r, i) => expectOk(r, `concurrent apply #${i}`).revision);
    equal(new Set(revisions).size, count, 'distinct revisions across concurrent applies');
    equal(edgesOf(await store.load(), n('bucket')).length, count, 'members of bucket after concurrent applies');
  });

  // ── honesty ───────────────────────────────────────────────────────────────

  add('capabilities are well-formed', async ({ caps }) => {
    const c = caps.closure;
    if (!c || !['native', 'client'].includes(c.read)) fail(`closure.read: expected 'native' | 'client', got ${show(c?.read)}`);
    if (typeof c.maintainedOnInsert !== 'boolean') fail(`closure.maintainedOnInsert: expected a boolean, got ${show(c.maintainedOnInsert)}`);
    if (!['exact', 'rebuild', 'unsupported'].includes(c.maintainedOnDelete)) {
      fail(`closure.maintainedOnDelete: expected 'exact' | 'rebuild' | 'unsupported', got ${show(c.maintainedOnDelete)}`);
    }
    if (typeof caps.serverFacetCounts !== 'boolean') fail(`serverFacetCounts: expected a boolean, got ${show(caps.serverFacetCounts)}`);
    if (!['n-plus-one', 'unsupported'].includes(caps.disjunctiveFacetCounts)) {
      fail(`disjunctiveFacetCounts: expected 'n-plus-one' | 'unsupported', got ${show(caps.disjunctiveFacetCounts)}`);
    }
    if (typeof caps.ordering !== 'boolean') fail(`ordering: expected a boolean, got ${show(caps.ordering)}`);
  });

  add('closure capability is honest', async ({ store, caps }) => {
    const native = caps.closure.read === 'native';
    if (!native) {
      if (store.closureIds) fail("closure.read is 'client' but the store has closureIds — declare 'native'");
      return;
    }
    if (!store.closureIds) fail("closure.read is 'native' but the store has no closureIds");
    const agree = async (what: string) => {
      const space = await store.load();
      for (const g of ['archive', 'research', 'leisure', 'reading']) {
        const want = [...closureIds(space, n(g))].sort();
        const got = [...(await store.closureIds!(n(g)))].sort();
        equal(got, want, `${what}: closureIds(${g})`);
      }
    };
    await seeded(store);
    if (caps.closure.maintainedOnInsert) await agree('after insert');
    expectOk(await store.apply({ removed: [edgeId('research>reading')] }), 'remove research>reading');
    if (caps.closure.maintainedOnDelete !== 'unsupported') await agree('after delete');
  });

  add(
    'subscribe notifies once per successful apply, never for a refused one',
    async ({ store }) => {
      const seen: GroupStoreChange[] = [];
      const off = store.subscribe!((c) => seen.push(c));
      const delta: EdgeDelta = { added: [edge('a', 'b')] };
      const r = expectOk(await store.apply(delta), 'apply');
      expectRefused(await store.apply({ added: [edge('b', 'a')] }), 'cycle', 'a cyclic delta');
      equal(seen.length, 1, 'notifications');
      equal(seen[0]!.revision, r.revision, 'notified revision');
      equal(seen[0]!.delta.added?.map((e) => e.id), ['a>b'], 'notified delta');
      off();
      expectOk(await store.apply({ added: [edge('a', 'c')] }), 'apply after unsubscribe');
      equal(seen.length, 1, 'notifications after unsubscribe');
    },
    { gate: subscribes },
  );

  add(
    'a throwing listener breaks neither the write nor the other listeners',
    async ({ store }) => {
      let calls = 0;
      store.subscribe!(() => {
        throw new Error('listener failure (expected by the contract kit)');
      });
      store.subscribe!(() => {
        calls += 1;
      });
      expectOk(await store.apply({ added: [edge('a', 'b')] }), 'apply with a throwing listener');
      equal(calls, 1, 'calls to the well-behaved listener');
      if (!(await store.load()).edges.has(edgeId('a>b'))) fail('the write was lost');
    },
    { gate: subscribes },
  );

  // ── persistence ───────────────────────────────────────────────────────────

  add(
    'a reopened store sees every write, tombstones included',
    async ({ store, reopen }) => {
      const before = await seeded(store);
      const del = deleteNodeDelta(before, n('research'));
      const after = expectOk(await store.apply(del), 'delete research');
      const other = await reopen();
      const loaded = await other.load();
      sameSpace(loaded, after, 'a reopened store');
      equal(loaded.revision, after.revision, 'revision of a reopened store');
      indexesConsistent(loaded, 'a reopened store');
      expectOk(await other.apply(invert(before, del)), 'undo through the reopened store');
      sameSpace(await (await reopen()).load(), before, 'a third instance after the undo');
    },
    { gate: persistent },
  );

  add(
    'a refused write leaves the persisted data untouched',
    async ({ store, reopen }) => {
      const before = await seeded(store);
      expectRefused(await store.apply({ added: [edge('reading', 'archive')] }), 'cycle', 'a cyclic delta');
      sameSpace(await (await reopen()).load(), before, 'a reopened store after the refusal');
    },
    { gate: persistent },
  );

  // ── materialize ───────────────────────────────────────────────────────────

  const probeBacking = newBacking();
  const probeStore = await options.make({ profile: resolveProfile('polyhierarchy'), backing: probeBacking, onListenerError: quiet });
  let probe: { caps: GroupStoreCapabilities; subscribes: boolean };
  try {
    probe = { caps: probeStore.getCapabilities(), subscribes: typeof probeStore.subscribe === 'function' };
  } finally {
    await options.dispose?.({ backing: probeBacking });
  }

  return cases.map(({ name, body, profile, gate }) => {
    const skip = options.skip?.[name] ?? gate?.(probe);
    const out: ContractCase = {
      name,
      run: async () => {
        const backing = newBacking();
        const errors: unknown[] = [];
        const ctx: GroupStoreContext = {
          profile: resolveProfile(profile),
          backing,
          onListenerError: (e) => errors.push(e),
        };
        let failure: unknown;
        try {
          const store = await options.make(ctx);
          await body({ store, reopen: async () => options.make(ctx), caps: store.getCapabilities(), errors });
        } catch (err) {
          failure = err;
        }
        try {
          await options.dispose?.({ backing });
        } catch (err) {
          if (failure === undefined) failure = err; // a case's own violation wins
        }
        if (failure !== undefined) throw failure;
      },
    };
    return skip ? { ...out, skip } : out;
  });
}
