/**
 * The HTTP store against the shared `GroupStore` contract kit, over the in-memory reference
 * endpoint (one endpoint per backing, so a reopened store sees the same document).
 */

import { describe, it } from 'vitest';
import { groupStoreContract } from '@zodal/groups-core/testing';
import { createHttpGroupStore, memorySnapshotEndpoint, type MemorySnapshotEndpoint } from '../src/index.js';

const endpoints = new Map<string, MemorySnapshotEndpoint>();

const cases = await groupStoreContract({
  make: ({ profile, backing, onListenerError, seed }) => {
    let endpoint = endpoints.get(backing);
    if (!endpoint) endpoints.set(backing, (endpoint = memorySnapshotEndpoint()));
    // Foreign data: put straight into the document, never through `apply`.
    if (seed) endpoint.set({ revision: seed.revision ?? 0, snapshot: { nodes: seed.nodes, edges: seed.edges } });
    return createHttpGroupStore({ url: `https://example.test/${backing}`, fetch: endpoint, profile, onListenerError });
  },
  persistent: true,
  dispose: ({ backing }) => {
    endpoints.delete(backing);
  },
});

describe('createHttpGroupStore: GroupStore contract', () => {
  for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
});
