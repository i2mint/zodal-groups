/**
 * Fluid groups (#44, D36): a persisted rule (a `FilterExpression` on the group's node) edited by
 * hand — pins are `tag`, exclusions `exclude`. The fleet case: a playlist defined as folder
 * patterns plus explicit tracks.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryGroupStore, type GroupStore } from '@zodal/groups-core';
import { createFsGroupStore } from '@zodal/groups-store-fs';
import { createInMemoryProvider } from '@zodal/store';
import type { FilterExpression } from '@zodal/core';
import { defineTaggedCollection } from '../src/index.js';

type Track = { id: string; path: string; groups?: string[] };
const tracks = (): Track[] => [
  { id: 't1', path: 'music/jazz/so-what.flac' },
  { id: 't2', path: 'music/jazz/live/blue-in-green.flac' },
  { id: 't3', path: 'music/blues/hoochie.flac' },
  { id: 't4', path: 'music/rock/paranoid.flac' },
  { id: 't5', path: 'podcasts/ep1.mp3' },
];
const jazzAndBlues: FilterExpression = {
  or: [
    { field: 'path', operator: 'startsWith', value: 'music/jazz/' },
    { field: 'path', operator: 'startsWith', value: 'music/blues/' },
  ],
};
const sorted = (xs: string[]) => [...xs].sort();

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function collection(store: GroupStore = createMemoryGroupStore({ profile: 'polyhierarchy' })) {
  return defineTaggedCollection<Track>({ provider: createInMemoryProvider(tracks()), spaces: { playlists: { edges: store } } });
}

describe('fluid groups', () => {
  it('extent = rule ∪ pinned \\ excluded, and every edit inverts', async () => {
    const tc = collection();
    const set = await tc.setRule('evening', jazzAndBlues, { label: 'Evening' });
    expect(set.ok).toBe(true);
    expect(tc.space().nodes.get('evening' as never)?.label).toBe('Evening');
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't2', 't3']);

    const pin = await tc.tag(['t4'], 'evening');
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't2', 't3', 't4']);
    const out = await tc.exclude(['t2', 't4'], 'evening');
    expect(out.ok).toBe(true);
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't3']);

    expect((await tc.unexclude(['t2'], 'evening')).ok).toBe(true);
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't2', 't3']);

    await tc.revert(out.inverse); // the pin of t4 comes back, t2's exclusion was already undone
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't2', 't3', 't4']);
    await tc.revert(pin.inverse);
    await tc.revert(set.inverse);
    expect(tc.space().nodes.has('evening' as never)).toBe(false);
    expect(await tc.extent('evening')).toEqual([]);
  });

  it('a rule can be replaced and removed, and the inverse restores it', async () => {
    const tc = collection();
    await tc.setRule('evening', jazzAndBlues);
    const narrower: FilterExpression = { field: 'path', operator: 'startsWith', value: 'music/jazz/live/' };
    const swap = await tc.setRule('evening', narrower);
    expect(await tc.extent('evening')).toEqual(['t2']);
    const drop = await tc.setRule('evening', null);
    expect(await tc.extent('evening')).toEqual([]);
    await tc.revert(drop.inverse);
    expect(await tc.extent('evening')).toEqual(['t2']);
    await tc.revert(swap.inverse);
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't2', 't3']);
    expect((await tc.setRule('nothing', null)).ok).toBe(true);
    expect(tc.space().nodes.has('nothing' as never)).toBe(false);
  });

  it('excluding twice is a no-op, and an unknown item fails alone', async () => {
    const tc = collection();
    await tc.setRule('evening', jazzAndBlues);
    await tc.exclude(['t1'], 'evening');
    const again = await tc.exclude(['t1', 'nope'], 'evening');
    expect(again.succeeded).toEqual(['t1']);
    expect(again.failed.map((f) => [f.id, f.code])).toEqual([['nope', 'notFound']]);
    expect([...tc.space().edges.values()].filter((e) => e.kind === 'excludes')).toHaveLength(1);
  });

  it('the rule and the edits persist in a GroupStore (fs)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zg-fluid-'));
    dirs.push(dir);
    const path = join(dir, 'groups.json');
    const first = collection(createFsGroupStore({ path, profile: 'polyhierarchy' }));
    await first.setRule('evening', jazzAndBlues);
    await first.tag(['t5'], 'evening');
    await first.exclude(['t3'], 'evening');
    const second = collection(createFsGroupStore({ path, profile: 'polyhierarchy' }));
    expect(sorted(await second.extent('evening'))).toEqual(['t1', 't2', 't5']);
  });

  it('an embedded space persists no rule or exclusion, but reads a rule declared on a vocabulary node', async () => {
    const tc = defineTaggedCollection<Track>({
      provider: createInMemoryProvider([...tracks().slice(0, 4), { id: 't5', path: 'podcasts/ep1.mp3', groups: ['evening'] }]),
      spaces: { groups: { edges: { embedded: 'groups' }, vocabulary: { nodes: [{ id: 'evening' as never, rule: jazzAndBlues }] } } },
    });
    await expect(tc.setRule('evening', jazzAndBlues)).rejects.toThrow(/cannot be persisted/);
    await expect(tc.exclude(['t1'], 'evening')).rejects.toThrow(/needs a GroupStore/);
    expect(sorted(await tc.extent('evening'))).toEqual(['t1', 't2', 't3', 't5']);
  });

  it('the commands drive it', async () => {
    const tc = collection();
    const cmd = (name: string) => tc.commands.find((c) => c.id === `groups.${name}`)!;
    expect((await cmd('setRule').execute({ group: 'evening', rule: jazzAndBlues, label: 'Evening' })).ok).toBe(true);
    expect((await cmd('exclude').execute({ ids: ['t1'], group: 'evening' })).ok).toBe(true);
    expect(sorted(await tc.extent('evening'))).toEqual(['t2', 't3']);
    expect((await cmd('unexclude').execute({ ids: ['t1'], group: 'evening' })).ok).toBe(true);
    expect((await cmd('setRule').execute({ group: 'evening', rule: null })).ok).toBe(true);
    expect(await tc.extent('evening')).toEqual([]);
  });
});
