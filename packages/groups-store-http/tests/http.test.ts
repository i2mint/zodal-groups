/**
 * The HTTP store's own behaviour: the wire format, 409 replay, pinned conflicts, a re-created
 * document, errors, headers, and `rebase`.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyDelta, createGroupSpace, edgeId, makeEdge, nodeId, type EdgeDelta } from '@zodal/groups-core';
import { createHttpGroupStore, HttpStoreError, memorySnapshotEndpoint, rebase, type FetchLike } from '../src/index.js';

const e = (parent: string, child: string) => makeEdge(nodeId(parent), nodeId(child), { id: edgeId(`${parent}>${child}`) });
const URL_ = 'https://example.test/groups';

describe('the wire', () => {
  it('GET then PUT with the base revision; the document carries revision and epoch', async () => {
    const endpoint = memorySnapshotEndpoint();
    const calls: { method: string; body?: unknown }[] = [];
    const fetch: FetchLike = (input, init) => {
      calls.push({ method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return endpoint(input, init);
    };
    const store = createHttpGroupStore({ url: URL_, fetch });
    const r = await store.apply({ added: [e('work', 'a')] });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]!.body).toMatchObject({ baseRevision: 0, revision: 1, snapshot: { edges: [{ parent: 'work', child: 'a' }] } });
    expect(endpoint.document).toMatchObject({ revision: 1, epoch: r.ok ? r.value.epoch : '' });
    expect((await store.loadVersioned()).epoch).toBe(endpoint.document!.epoch);
  });

  it('sends the host headers, per request', async () => {
    const endpoint = memorySnapshotEndpoint();
    const seen: string[] = [];
    const fetch: FetchLike = (input, init) => {
      seen.push(String((init?.headers as Record<string, string>).authorization));
      return endpoint(input, init);
    };
    let token = 't1';
    const store = createHttpGroupStore({ url: URL_, fetch, headers: () => ({ authorization: `Bearer ${token}` }) });
    await store.load();
    token = 't2';
    await store.apply({ added: [e('g', 'a')] });
    expect(seen).toEqual(['Bearer t1', 'Bearer t2', 'Bearer t2']);
  });

  it('keepalive is opt-in, on writes only', async () => {
    const endpoint = memorySnapshotEndpoint();
    const inits: RequestInit[] = [];
    const fetch: FetchLike = (input, init) => (inits.push(init ?? {}), endpoint(input, init));
    await createHttpGroupStore({ url: URL_, fetch, keepalive: true }).apply({ added: [e('g', 'a')] });
    expect(inits.map((i) => i.keepalive)).toEqual([undefined, true]);
  });
});

describe('two writers', () => {
  it('an unpinned write that loses the race replays on the newer document (both land)', async () => {
    const endpoint = memorySnapshotEndpoint();
    // A foreign write lands between this store's GET and its PUT.
    let sneak = true;
    const fetch: FetchLike = async (input, init) => {
      if (init?.method === 'PUT' && sneak) {
        sneak = false;
        const other = createHttpGroupStore({ url: URL_, fetch: endpoint });
        await other.apply({ added: [e('g', 'theirs')] });
      }
      return endpoint(input, init);
    };
    const store = createHttpGroupStore({ url: URL_, fetch });
    const r = await store.apply({ added: [e('g', 'mine')] });
    expect(r.ok).toBe(true);
    const edges = endpoint.document!.snapshot.edges.map((x) => x.child).sort();
    expect(edges).toEqual(['mine', 'theirs']);
    expect(endpoint.document!.revision).toBe(2);
  });

  it('a write pinned to a revision that moved is a conflict, writing nothing', async () => {
    const endpoint = memorySnapshotEndpoint();
    const a = createHttpGroupStore({ url: URL_, fetch: endpoint });
    const b = createHttpGroupStore({ url: URL_, fetch: endpoint });
    const first = await a.apply({ added: [e('g', 'x')] });
    if (!first.ok) throw new Error('refused');
    await b.apply({ added: [e('g', 'y')] });
    const stale = await a.apply(first.value.inverse, { expectedRevision: first.value.revision, expectedEpoch: first.value.epoch });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.violations[0]!.code).toBe('conflict');
    expect(endpoint.document!.snapshot.edges).toHaveLength(2);
  });

  it('a document deleted and re-created is a new history: an old epoch conflicts', async () => {
    const endpoint = memorySnapshotEndpoint();
    const store = createHttpGroupStore({ url: URL_, fetch: endpoint });
    const first = await store.apply({ added: [e('g', 'x')] });
    if (!first.ok) throw new Error('refused');
    endpoint.set(null);
    const fresh = await store.apply({ added: [e('g', 'y')] });
    if (!fresh.ok) throw new Error('refused');
    expect(fresh.value.epoch).not.toBe(first.value.epoch);
    const old = await store.apply({ added: [e('g', 'z')] }, { expectedEpoch: first.value.epoch, expectedRevision: fresh.value.revision });
    expect(old.ok).toBe(false);
  });

  it('gives up after maxReplays when the document keeps moving', async () => {
    const endpoint = memorySnapshotEndpoint();
    let n = 0;
    const fetch: FetchLike = async (input, init) => {
      if (init?.method === 'PUT') await createHttpGroupStore({ url: URL_, fetch: endpoint }).apply({ added: [e('g', `other${n++}`)] });
      return endpoint(input, init);
    };
    const r = await createHttpGroupStore({ url: URL_, fetch, maxReplays: 2 }).apply({ added: [e('g', 'mine')] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('conflict');
    expect(n).toBe(3);
  });

  it('applies on one store are serialized (no self-conflict)', async () => {
    const endpoint = memorySnapshotEndpoint();
    const store = createHttpGroupStore({ url: URL_, fetch: endpoint, maxReplays: 0 });
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((x) => store.apply({ added: [e('g', x)] })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(endpoint.document!.revision).toBe(4);
  });
});

describe('errors', () => {
  it('a 500 rejects with HttpStoreError and its status', async () => {
    const fetch: FetchLike = async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    await expect(createHttpGroupStore({ url: URL_, fetch }).load()).rejects.toMatchObject({ name: 'HttpStoreError', status: 500 });
  });

  it('a malformed document rejects, naming the field', async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ revision: -1, snapshot: { nodes: [], edges: [] } }), { status: 200 });
    await expect(createHttpGroupStore({ url: URL_, fetch }).load()).rejects.toThrow(/"revision" must be a non-negative integer/);
    const bad: FetchLike = async () => new Response(JSON.stringify({ revision: 1, snapshot: { nodes: 'x' } }), { status: 200 });
    await expect(createHttpGroupStore({ url: URL_, fetch: bad }).load()).rejects.toBeInstanceOf(HttpStoreError);
  });

  it('a refused delta is { ok: false } and never PUT', async () => {
    const endpoint = memorySnapshotEndpoint();
    const spy = vi.fn(endpoint);
    const store = createHttpGroupStore({ url: URL_, fetch: spy as FetchLike });
    await store.apply({ added: [e('a', 'b')] });
    const r = await store.apply({ added: [e('b', 'a')] }); // a cycle
    expect(r.ok).toBe(false);
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
});

describe('rebase', () => {
  it('replays pending deltas on a newer remote: duplicates dropped, refusals reported', () => {
    let remote = createGroupSpace({ profile: 'polyhierarchy' });
    const r1 = applyDelta(remote, { added: [e('g', 'a'), e('b', 'c')] });
    if (!r1.ok) throw new Error('seed');
    remote = r1.value;
    const pending: EdgeDelta[] = [
      { added: [makeEdge(nodeId('g'), nodeId('a'), { id: edgeId('local-1') })] }, // already there remotely
      { added: [e('h', 'a')] },
      { added: [e('c', 'b')] }, // a cycle on the remote
      { removed: [edgeId('gone')] }, // already gone
    ];
    const out = rebase(remote, pending);
    expect(out.refused.map((r) => r.violations[0]!.code)).toEqual(['cycle']);
    expect(out.applied).toHaveLength(3);
    expect([...out.space.edges.values()].map((x) => `${x.parent}>${x.child}`).sort()).toEqual(['b>c', 'g>a', 'h>a']);
  });
});
