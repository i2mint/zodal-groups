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
import { deleteNodeDelta, edgesInto, edgesOf, invert, makeEdge, mergeDelta } from './space.js';
import { closureIds } from './closure.js';
import type { GroupStore, GroupStoreCapabilities, GroupStoreChange } from './store.js';
import type { GroupSnapshot } from './snapshot.js';
import { detectCycles } from './closure.js';

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
  /**
   * When present, the store must open holding exactly this snapshot, written AS IS to its backing —
   * not validated, as if a foreign tool had written it (D8: data may break the profile, or even be
   * cyclic, and must still load). Only given to the first `make` of a case.
   */
  readonly seed?: GroupSnapshot;
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
  interface CaseSpec {
    name: string;
    body: Body;
    profile: ProfileName | GroupProfile;
    gate?: Gate;
    seed?: GroupSnapshot;
  }
  const cases: CaseSpec[] = [];
  const add = (
    name: string,
    body: Body,
    opts: { profile?: ProfileName | GroupProfile; gate?: Gate; seed?: GroupSnapshot } = {},
  ) =>
    cases.push({
      name,
      body,
      profile: opts.profile ?? 'polyhierarchy',
      ...(opts.gate ? { gate: opts.gate } : {}),
      ...(opts.seed ? { seed: opts.seed } : {}),
    });

  const persistent: Gate = () => (options.persistent ? undefined : 'store is not persistent (options.persistent is not true)');
  const subscribes: Gate = (p) => (p.subscribes ? undefined : 'store has no subscribe (it is optional)');

  const seeded = async (store: GroupStore): Promise<GroupSpace> => {
    expectOk(await store.apply(SEED), 'seed delta');
    return store.load();
  };

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

  add('the inverse apply returns restores the space exactly', async ({ store }) => {
    const before = await seeded(store);
    const delta: EdgeDelta = {
      added: [edge('archive', 'novel.epub'), edge('inbox', 'fresh.txt')], // inbox, fresh.txt are new
      removed: [edgeId('reading>notes.md')],
      upsertNodes: [
        { id: n('reading'), label: 'To read' }, // changed
        { id: n('notes.md'), label: 'Notes' }, // a field it did not have
      ],
    };
    const applied = expectOk(await store.apply(delta), 'the delta');
    if (!(await store.load()).nodes.has(n('inbox'))) fail('the delta should have created node inbox');
    equal(applied.inverse, invert(before, delta), 'the returned inverse vs invert(before, delta)');
    expectOk(await store.apply(applied.inverse, { expectedRevision: applied.revision }), 'its inverse');
    sameSpace(await store.load(), before, 'load() after apply + inverse');
  });

  add("deleting a group is undone by its tombstone: label, payload and edges come back", async ({ store }) => {
    const before = await seeded(store);
    const del = deleteNodeDelta(before, n('reading'));
    equal(del.removedNodes?.map((x) => x.id), ['reading'], 'deleteNodeDelta tombstones');
    const applied = expectOk(await store.apply(del), 'delete reading');
    const gone = await store.load();
    if (gone.nodes.has(n('reading'))) fail('reading survived its delete');
    if (edgesInto(gone, n('paper.pdf')).length) fail('paper.pdf is still in a group after reading was deleted');
    expectOk(await store.apply(applied.inverse, { expectedRevision: applied.revision }), 'undo the delete');
    const restored = await store.load();
    sameSpace(restored, before, 'load() after undoing the delete');
    equal(restored.nodes.get(n('reading')), { id: 'reading', label: 'Reading', payload: { colour: 'blue' } }, 'the restored node');
  });

  add('a stale undo is refused: it neither deletes nor merges a node changed since', async ({ store }) => {
    const s0 = await store.load();
    const add: EdgeDelta = { added: [edge('g', 'a')] }; // creates g and a
    expectOk(await store.apply(add), 'add a to a new group g');
    expectOk(await store.apply({ upsertNodes: [{ id: n('g'), label: 'Someone else\'s now' }] }), 'relabel g');
    expectRefused(await store.apply(invert(s0, add)), 'staleTombstone', 'undo the add after g changed');
    equal((await store.load()).nodes.get(n('g'))?.label, "Someone else's now", 'g after the refused undo');

    const s1 = await store.load();
    const del = deleteNodeDelta(s1, n('a'));
    expectOk(await store.apply(del), 'delete a');
    expectOk(await store.apply({ upsertNodes: [{ id: n('a'), label: 'A new a' }] }), 're-create a');
    expectRefused(await store.apply(invert(s1, del)), 'nodeExists', 'undo the delete after a was re-created');
    equal((await store.load()).nodes.get(n('a')), { id: 'a', label: 'A new a' }, 'a after the refused undo');
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
    const merge = mergeDelta(before, n('todo'), n('to-do'));
    const applied = expectOk(await store.apply(merge), 'the merge');
    equal(edgesOf(await store.load(), n('to-do')).map((e) => e.child).sort(), ['a', 'b', 'c'], 'to-do after the merge');
    expectOk(await store.apply(applied.inverse, { expectedRevision: applied.revision }), 'undo the merge');
    sameSpace(await store.load(), before, 'load() after undoing the merge');
  });

  // ── concurrency ───────────────────────────────────────────────────────────

  add('apply returns the new revision, the exact inverse, and (if any) the space load() would give', async ({ store }) => {
    const before = await seeded(store);
    const delta: EdgeDelta = { added: [edge('inbox', 'paper.pdf')] };
    const applied = expectOk(await store.apply(delta), 'apply');
    const loaded = await store.load();
    equal(applied.revision, loaded.revision, 'returned revision vs load().revision');
    if (!(applied.revision > before.revision)) fail(`revision did not advance: ${before.revision} → ${applied.revision}`);
    equal(applied.inverse, invert(before, delta), 'returned inverse');
    if (applied.space) sameSpace(applied.space, loaded, 'returned space vs load()');
  });

  add('concurrent applies each get the inverse of their own write (exactly one creates the contested node)', async ({ store }) => {
    // Six writers file an item under a group X that does not exist yet. Exactly one of them
    // creates X, so exactly one inverse may tombstone it. A store that computes inverses from a
    // read taken before its serialized section hands that tombstone to several writers.
    const start = await store.load();
    const count = 6;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) => store.apply({ added: [edge('X', `item-${i}`)] })),
    );
    const applied = results.map((r, i) => expectOk(r, `concurrent apply #${i}`));
    const creators = applied.filter((a) => a.inverse.removedNodes?.some((x) => x.id === 'X'));
    equal(creators.length, 1, 'inverses that tombstone the contested node X');
    // Replaying the inverses newest-first must walk back to the start exactly.
    for (const a of [...applied].sort((x, y) => y.revision - x.revision)) {
      expectOk(await store.apply(a.inverse), `undo of revision ${a.revision}`);
    }
    sameSpace(await store.load(), start, 'load() after undoing every concurrent write');
  });

  add('expectedRevision: the current revision is accepted; a stale one is refused (conflict), writing nothing', async ({ store }) => {
    const r1 = expectOk(await store.apply({ added: [edge('g', 'a')] }), 'first write').revision;
    expectOk(await store.apply({ added: [edge('g', 'b')] }, { expectedRevision: r1 }), 'a write at the current revision');
    const before = await store.load();
    const v = expectRefused(await store.apply({ added: [edge('g', 'c')] }, { expectedRevision: r1 }), 'conflict', 'a write at a stale revision');
    equal([v.expectedRevision, v.actualRevision], [r1, before.revision], '[expectedRevision, actualRevision]');
    sameSpace(await store.load(), before, 'load() after the conflict');
    equal((await store.load()).revision, before.revision, 'revision after the conflict');
  });

  add("a compensating undo after another writer used the created node is refused, not half-applied", async ({ store }) => {
    // Writer A files i1 under a new group q3; writer B then files q3 under plans; A's record write
    // fails and A compensates with the inverse it was given.
    const a = expectOk(await store.apply({ added: [edge('q3', 'i1')] }), 'A: i1 into a new q3');
    expectOk(await store.apply({ added: [edge('plans', 'q3')] }), 'B: q3 into plans');
    const before = await store.load();
    expectRefused(await store.apply(a.inverse, { expectedRevision: a.revision }), 'conflict', "A's compensation");
    sameSpace(await store.load(), before, "load() after A's refused compensation");
  });

  add("an undo with a stale expectedRevision never overwrites another writer's change", async ({ store }) => {
    expectOk(await store.apply({ upsertNodes: [{ id: n('g'), label: 'G' }], added: [edge('g', 'x')] }), 'seed');
    const a = expectOk(await store.apply({ upsertNodes: [{ id: n('g'), label: 'A says' }] }), 'A renames g');
    expectOk(await store.apply({ upsertNodes: [{ id: n('g'), label: 'B says' }] }), 'B renames g');
    expectRefused(await store.apply(a.inverse, { expectedRevision: a.revision }), 'conflict', "A's undo");
    equal((await store.load()).nodes.get(n('g'))?.label, 'B says', "g's label after A's refused undo");
  });

  add('concurrent applies are serialized: none is lost', async ({ store }) => {
    const count = 25;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) => store.apply({ added: [edge('bucket', `item-${i}`)] })),
    );
    const revisions = results.map((r, i) => expectOk(r, `concurrent apply #${i}`).revision);
    equal(new Set(revisions).size, count, 'distinct revisions across concurrent applies');
    equal(edgesOf(await store.load(), n('bucket')).length, count, 'members of bucket after concurrent applies');
  });

  // ── shapes a naive store gets wrong ───────────────────────────────────────

  add('a diamond keeps its closure when one route is removed', async ({ store }) => {
    // X ⊃ A ⊃ C and X ⊃ B ⊃ C. Removing A ⊃ C must leave C inside X (via B): a closure table that
    // deletes (X, C) on any route's removal — the path_count/DRed bug — fails here.
    expectOk(
      await store.apply({ added: [edge('X', 'A'), edge('X', 'B'), edge('A', 'C'), edge('B', 'C'), edge('C', 'item')] }),
      'the diamond',
    );
    expectOk(await store.apply({ removed: [edgeId('A>C')] }), 'remove A ⊃ C');
    const space = await store.load();
    const want: string[] = [...closureIds(space, n('X'))].sort();
    for (const id of ['C', 'item']) if (!want.includes(id)) fail(`closure of X lost ${id} after removing one route (${show(want)})`);
    if (store.closureIds) equal([...(await store.closureIds(n('X')))].sort(), want, 'native closureIds(X)');
  });

  add('two edge kinds between the same pair are two edges', async ({ store }) => {
    // D3: the edge is reified and carries its kind. A store keyed on (parent, child) collapses them.
    const partOf = edge('car', 'wheel', { kind: 'part_of', id: edgeId('car>wheel:part_of') });
    const isA = edge('car', 'wheel', { kind: 'is_a', id: edgeId('car>wheel:is_a') });
    expectOk(await store.apply({ added: [partOf, isA] }), 'part_of and is_a between car and wheel');
    equal(edgesOf(await store.load(), n('car')).map((e) => e.kind).sort(), ['is_a', 'part_of'], 'kinds car → wheel');
    expectOk(await store.apply({ removed: [partOf.id] }), 'remove the part_of edge');
    equal(edgesOf(await store.load(), n('car')).map((e) => e.kind), ['is_a'], 'kinds car → wheel after removing part_of');
  });

  add(
    'foreign data loads as it is — cyclic and profile-breaking — and stays writable',
    async ({ store }) => {
      const space = await store.load();
      equal(space.edges.size, 4, 'edges loaded from the foreign snapshot');
      equal(space.revision, 7, 'revision loaded from the foreign snapshot');
      equal(space.nodes.get(n('a')), { id: 'a', label: 'A' }, 'node a');
      indexesConsistent(space, 'the foreign space');
      if (!detectCycles(space).length) fail('the seeded cycle a → b → a was not loaded');
      expectOk(await store.apply({ added: [edge('docs', 'note.txt')] }), 'a valid write on top of foreign data');
      expectRefused(await store.apply({ added: [edge('f3', 'x')] }), 'maxParentsPerItem', 'a write that breaks the profile further');
    },
    {
      profile: 'filesystem',
      seed: {
        nodes: [{ id: n('a'), label: 'A' }],
        // a ⊃ b ⊃ a is a cycle; x in two folders breaks `filesystem`. The write path would refuse both.
        edges: [edge('a', 'b'), edge('b', 'a'), edge('f1', 'x'), edge('f2', 'x')],
        revision: 7,
      },
    },
  );

  add('load() hands out a view the caller cannot use to change the store', async ({ store }) => {
    await seeded(store);
    const space = await store.load();
    const before = show(normalize(space));
    try {
      (space.nodes as Map<NodeId, Node>).set(n('intruder'), { id: n('intruder') });
    } catch {
      /* a read-only view may throw — that is fine */
    }
    try {
      (space.forward.get(n('reading')) as Set<string> | undefined)?.clear();
    } catch {
      /* likewise */
    }
    equal(show(normalize(await store.load())), before, 'load() after mutating a loaded space');
    indexesConsistent(await store.load(), 'load() after mutating a loaded space');
  });

  add(
    'two instances on one backing, writing concurrently, lose nothing',
    async ({ store, reopen }) => {
      const other = await reopen();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).apply({ added: [edge('bucket', `item-${i}`)] })),
      );
      const revisions = results.map((r, i) => expectOk(r, `concurrent apply #${i}`).revision);
      equal(new Set(revisions).size, 20, 'distinct revisions');
      equal(edgesOf(await store.load(), n('bucket')).length, 20, 'members of bucket (instance 1)');
      equal(edgesOf(await other.load(), n('bucket')).length, 20, 'members of bucket (instance 2)');
    },
    { gate: persistent },
  );

  // ── honesty ───────────────────────────────────────────────────────────────

  add('capabilities are well-formed', async ({ caps }) => {
    const c = caps.closure;
    if (!c || !['native', 'client'].includes(c.read)) fail(`closure.read: expected 'native' | 'client', got ${show(c?.read)}`);
    if (typeof c.maintainedOnInsert !== 'boolean') fail(`closure.maintainedOnInsert: expected a boolean, got ${show(c.maintainedOnInsert)}`);
    if (!['exact', 'rebuild', 'unsupported'].includes(c.maintainedOnDelete)) {
      fail(`closure.maintainedOnDelete: expected 'exact' | 'rebuild' | 'unsupported', got ${show(c.maintainedOnDelete)}`);
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
      equal(seen[0]!.inverse, r.inverse, 'notified inverse');
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
      const expected = await store.load();
      const other = await reopen();
      const loaded = await other.load();
      sameSpace(loaded, expected, 'a reopened store');
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
    await probeStore.dispose?.();
    await options.dispose?.({ backing: probeBacking });
  }

  return cases.map(({ name, body, profile, gate, seed }) => {
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
        const opened: GroupStore[] = [];
        const open = async (withSeed: boolean) => {
          const store = await options.make(withSeed && seed ? { ...ctx, seed } : ctx);
          opened.push(store);
          return store;
        };
        let failure: unknown;
        try {
          const store = await open(true);
          await body({ store, reopen: () => open(false), caps: store.getCapabilities(), errors });
        } catch (err) {
          failure = err;
        }
        try {
          for (const store of opened) await store.dispose?.();
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
