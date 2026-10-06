/**
 * The fs adapter against the shared `GroupStore` contract kit, over a real temp directory. The
 * manifest sits two directories deep so every case also exercises "create the parent directory".
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { groupStoreContract } from '@zodal/groups-core/testing';
import { createFsGroupStore, serializeManifest } from '../src/index.js';

const dirs = new Map<string, Promise<string>>();
const dirFor = (backing: string) => {
  if (!dirs.has(backing)) dirs.set(backing, mkdtemp(join(tmpdir(), 'groups-store-fs-')));
  return dirs.get(backing)!;
};

const cases = await groupStoreContract({
  make: async ({ profile, backing, onListenerError, seed }) => {
    const path = join(await dirFor(backing), 'nested', 'dir', 'groups.json');
    if (seed) {
      // Foreign data: written straight to the manifest, never through `apply`.
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, serializeManifest(seed));
    }
    return createFsGroupStore({ path, profile, onListenerError });
  },
  persistent: true,
  dispose: async ({ backing }) => {
    const dir = dirs.get(backing);
    dirs.delete(backing);
    if (dir) await rm(await dir, { recursive: true, force: true });
  },
});

describe('createFsGroupStore: GroupStore contract', () => {
  for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
});
