/**
 * `operations` and `commands` (acture's CommandRecord shape, shared ids), the inverse riding as an
 * effect for an app's undo history, and isolated `subscribe` listeners.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInMemoryProvider } from '@zodal/store';
import {
  commandId,
  defineTaggedCollection,
  INVERSE_EFFECT,
  operations,
  type CollectionInverse,
  type CommandEffect,
  type OperationResult,
} from '../src/index.js';
import { groupsOf, items, state, type Item } from './helpers.js';

const ACTURE_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const make = (options: { commandNamespace?: string; onListenerError?: (e: unknown) => void } = {}) =>
  defineTaggedCollection<Item>({ provider: createInMemoryProvider(items()), spaces: { tags: { edges: { embedded: 'tags' } } }, ...options });

describe('operations and commands', () => {
  it('declare the same operations, with acture-valid, namespaced ids', () => {
    const tc = make();
    expect(tc.operations).toBe(operations);
    expect(tc.commands.map((c) => c.id)).toEqual(operations.map((o) => `groups.${o.name}`));
    for (const c of tc.commands) {
      expect(c.id).toMatch(ACTURE_ID);
      expect(c.title.length).toBeGreaterThan(0);
      expect(() => z.toJSONSchema(c.params)).not.toThrow(); // acture needs JSON-Schema-representable params
    }
    expect(make({ commandNamespace: 'notes.tag-ui' }).commands[0]!.id).toBe('notes.tagUi.create');
    expect(commandId('my_app', 'bulk-tag')).toBe('myApp.bulkTag');
    expect(operations.find((o) => o.name === 'deleteGroup')).toMatchObject({ variant: 'destructive', confirm: true });
  });

  it('execute returns the operation result as value, and its inverse as an effect', async () => {
    const tc = make();
    const start = await state(tc);
    const tag = tc.commands.find((c) => c.id === 'groups.tag')!;
    const r = await tag.execute({ ids: ['a', 'c'], group: 'urgent' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as OperationResult<Item>).succeeded).toEqual(['a', 'c']);
    const effect = r.effects![0]!;
    expect(effect.type).toBe(INVERSE_EFFECT);
    await tc.revert(effect.inverse as CollectionInverse<Item>);
    expect(await state(tc)).toEqual(start);
  });

  it('works under an acture-undo-style host: onEffect reverts on undo and re-applies on redo', async () => {
    const tc = make();
    const start = await state(tc);
    // What an app's onEffect handler does: keep the redo inverse each undo returns.
    const redoOf = new WeakMap<CommandEffect, CollectionInverse<Item>>();
    const onEffect = async (effect: CommandEffect, { isUndo, isRedo }: { isUndo: boolean; isRedo: boolean }) => {
      if (effect.type !== INVERSE_EFFECT) return;
      if (isUndo) redoOf.set(effect, (await tc.revert(effect.inverse as CollectionInverse<Item>)).inverse);
      if (isRedo) await tc.revert(redoOf.get(effect)!);
    };
    const merge = tc.commands.find((c) => c.id === 'groups.mergeGroups')!;
    const r = await merge.execute({ from: 'urgent', into: 'work' });
    if (!r.ok) throw new Error(r.error.message);
    const after = await state(tc);
    await onEffect(r.effects![0]!, { isUndo: true, isRedo: false });
    expect(await state(tc)).toEqual(start);
    await onEffect(r.effects![0]!, { isUndo: false, isRedo: true });
    expect(await state(tc)).toEqual(after);
  });

  it('every item failed → { ok: false, error } with the failures as details; partial → ok with value.failed', async () => {
    const tc = make();
    const tag = tc.commands.find((c) => c.id === 'groups.tag')!;
    const none = await tag.execute({ ids: ['nope'], group: 'x' });
    expect(none).toMatchObject({ ok: false, error: { code: 'notFound', details: { failed: [{ id: 'nope' }] } } });
    const some = await tag.execute({ ids: ['a', 'nope'], group: 'x' });
    expect(some.ok).toBe(true);
    if (some.ok) expect((some.value as OperationResult<Item>).failed).toHaveLength(1);
  });

  it('a no-op succeeds without an effect (nothing to undo)', async () => {
    const tc = make();
    const r = await tc.commands.find((c) => c.id === 'groups.tag')!.execute({ ids: ['a'], group: 'work' });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.effects).toBeUndefined();
  });

  it('invalid params and throws become errors as data', async () => {
    const tc = make();
    const tag = tc.commands.find((c) => c.id === 'groups.tag')!;
    expect(await tag.execute({ ids: [], group: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await tag.execute({ ids: ['a'], group: 'x', space: 'nope' })).toMatchObject({ ok: false, error: { code: 'execute_threw' } });
  });

  it('every command runs', async () => {
    const tc = make();
    const run = (name: string, params: unknown) => tc.commands.find((c) => c.id === `groups.${name}`)!.execute(params);
    expect((await run('create', { item: { id: 'e', title: 'E' }, groups: ['new'] })).ok).toBe(true);
    expect((await run('untag', { ids: ['e'], group: 'new' })).ok).toBe(true);
    expect((await run('bulkTag', { ids: ['c', 'd'], add: ['x', 'y'] })).ok).toBe(true);
    expect((await run('removeFromGroup', { id: 'c', group: 'x' })).ok).toBe(true);
    expect((await run('renameGroup', { group: 'y', name: 'why' })).ok).toBe(true);
    expect((await run('deleteGroup', { group: 'why' })).ok).toBe(true);
    expect((await run('deleteItem', { id: 'e' })).ok).toBe(true);
    expect(groupsOf(tc, 'd')).toEqual(['x']);
  });
});

describe('subscribe', () => {
  it('notifies once per operation that changed something; a throwing listener is isolated', async () => {
    const errors: unknown[] = [];
    const tc = make({ onListenerError: (e) => errors.push(e) });
    const good = vi.fn();
    tc.subscribe(() => {
      throw new Error('bad listener');
    });
    const off = tc.subscribe(good);

    const r = await tc.tag(['a'], 'urgent');
    expect(r.ok).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[0]![0]).toMatchObject({ operation: 'tag', result: { succeeded: ['a'] } });
    expect(errors).toHaveLength(1);

    await tc.tag(['a'], 'urgent'); // no-op: no notification
    expect(good).toHaveBeenCalledTimes(1);

    off();
    await tc.untag(['a'], 'urgent');
    expect(good).toHaveBeenCalledTimes(1);
  });
});
