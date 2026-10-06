/**
 * Every operation, over every backing (embedded field, memory GroupStore, fs GroupStore): its
 * effect, and that its inverse undoes it EXACTLY (records and spaces) and the inverse of that redoes
 * it exactly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryProvider } from '@zodal/store';
import { defineTaggedCollection, type OperationResult, type TaggedCollection } from '../src/index.js';
import { BACKINGS, groupsOf, items, state, type Backing, type Item } from './helpers.js';

/** Run `op`, check it, then: revert restores the start exactly, and reverting the revert restores the result exactly. */
async function undoable(
  tc: TaggedCollection<Item>,
  op: () => Promise<OperationResult<Item>>,
  check: (r: OperationResult<Item>) => void | Promise<void> = () => undefined,
): Promise<OperationResult<Item>> {
  const start = await state(tc);
  const r = await op();
  expect(r.failed).toEqual([]);
  await check(r);
  const after = await state(tc);
  const undo = await tc.revert(r.inverse);
  expect(undo.failed).toEqual([]);
  expect(await state(tc)).toEqual(start);
  const redo = await tc.revert(undo.inverse);
  expect(redo.failed).toEqual([]);
  expect(await state(tc)).toEqual(after);
  return r;
}

for (const { name, make } of BACKINGS) {
  describe(`operations — ${name}`, () => {
    let backing: Backing;
    let tc: TaggedCollection<Item>;
    const embedded = name === 'embedded';
    const record = async (id: string) => tc.provider.getOne(id);

    beforeEach(async () => {
      backing = await make();
      tc = defineTaggedCollection<Item>({
        provider: createInMemoryProvider(items()),
        spaces: { tags: await backing.space({ seed: items() }) },
      });
      await tc.load();
    });
    afterEach(() => backing.dispose());

    it('loads the memberships', () => {
      expect(groupsOf(tc, 'a')).toEqual(['work']);
      expect(groupsOf(tc, 'b')).toEqual(['urgent', 'work']);
      expect(groupsOf(tc, 'c')).toEqual([]);
    });

    it('tag: bulk, one undo step', async () => {
      await undoable(
        tc,
        () => tc.tag(['a', 'c', 'd'], 'urgent'),
        async (r) => {
          expect(r.succeeded).toEqual(['a', 'c', 'd']);
          expect(groupsOf(tc, 'a')).toEqual(['urgent', 'work']);
          expect(groupsOf(tc, 'd')).toEqual(['urgent']);
          if (embedded) {
            expect((await record('a')).tags).toEqual(['work', 'urgent']); // appended, order kept
            expect((await record('d')).tags).toEqual(['urgent']);
          }
        },
      );
    });

    it('tag: an item already in the group is a success that changes nothing', async () => {
      const r = await tc.tag(['b'], 'work');
      expect(r).toMatchObject({ ok: true, succeeded: ['b'], failed: [] });
      expect(r.inverse.items).toEqual([]);
    });

    it('tag: a missing record fails alone', async () => {
      const r = await tc.tag(['a', 'nope'], 'urgent');
      expect(r.succeeded).toEqual(['a']);
      expect(r.failed).toMatchObject([{ id: 'nope', code: 'notFound' }]);
      expect(groupsOf(tc, 'a')).toContain('urgent');
    });

    it('untag', async () => {
      await undoable(
        tc,
        () => tc.untag(['a', 'b'], 'work'),
        async () => {
          expect(groupsOf(tc, 'a')).toEqual([]);
          expect(groupsOf(tc, 'b')).toEqual(['urgent']);
          if (embedded) {
            expect((await record('b')).tags).toEqual(['urgent']);
            // Nobody is in `work` any more, and a reload would not derive it: it goes.
            expect(tc.space().nodes.has('work' as never)).toBe(false);
          } else {
            // A store's group is a real node: it stays, empty.
            expect(tc.space().nodes.has('work' as never)).toBe(true);
          }
        },
      );
    });

    it('bulkTag: add and remove several groups on several items, as one operation', async () => {
      await undoable(
        tc,
        () => tc.bulkTag(['a', 'b', 'c'], { add: ['later', 'home'], remove: ['work'] }),
        () => {
          expect(groupsOf(tc, 'a')).toEqual(['home', 'later']);
          expect(groupsOf(tc, 'b')).toEqual(['home', 'later', 'urgent']);
          expect(groupsOf(tc, 'c')).toEqual(['home', 'later']);
        },
      );
    });

    it('removeFromGroup is membership only: the record, the group and the other memberships stay', async () => {
      await undoable(
        tc,
        () => tc.removeFromGroup('b', 'work'),
        async () => {
          expect(groupsOf(tc, 'b')).toEqual(['urgent']);
          expect(groupsOf(tc, 'a')).toEqual(['work']);
          expect((await record('b')).title).toBe('Beta');
        },
      );
    });

    it('create with groups: the record and its edges together', async () => {
      await undoable(
        tc,
        () => tc.create({ id: 'e', title: 'Epsilon' }, { groups: ['work', 'new'] }),
        async (r) => {
          expect(r.succeeded).toEqual(['e']);
          expect(r.record).toMatchObject({ id: 'e', title: 'Epsilon' });
          expect(groupsOf(tc, 'e')).toEqual(['new', 'work']);
          if (embedded) expect((await record('e')).tags).toEqual(['work', 'new']);
        },
      );
    });

    it('create without an id: the provider assigns one, and the edges use it', async () => {
      const r = await tc.create({ title: 'Anonymous' } as Item, { groups: ['work'] });
      expect(r.ok).toBe(true);
      const id = String(r.record!.id);
      expect(r.succeeded).toEqual([id]);
      expect(groupsOf(tc, id)).toEqual(['work']);
      await tc.revert(r.inverse);
      await expect(tc.provider.getOne(id)).rejects.toThrow();
      expect(groupsOf(tc, id)).toEqual([]);
    });

    it('create of an existing id fails, writing nothing', async () => {
      const before = await state(tc);
      const r = await tc.create({ id: 'a', title: 'again' }, { groups: ['x'] });
      expect(r.failed).toMatchObject([{ id: 'a', code: 'exists' }]);
      expect(await state(tc)).toEqual(before);
    });

    it('deleteItem: the record and its memberships', async () => {
      await undoable(
        tc,
        () => tc.deleteItem('b'),
        async () => {
          await expect(record('b')).rejects.toThrow();
          expect(tc.space().nodes.has('b' as never)).toBe(false);
          expect(groupsOf(tc, 'b')).toEqual([]);
          expect(groupsOf(tc, 'a')).toEqual(['work']);
        },
      );
    });

    it('deleteGroup: the node and every edge touching it; the members stay', async () => {
      await undoable(
        tc,
        () => tc.deleteGroup('work'),
        async (r) => {
          expect(r.ok).toBe(true);
          expect(r.succeeded).toContain('work'); // the group, in either mode
          if (embedded) expect(r.succeeded).toEqual(['a', 'b', 'work']); // and the members it rewrote
          expect(tc.space().nodes.has('work' as never)).toBe(false);
          expect(groupsOf(tc, 'a')).toEqual([]);
          expect(groupsOf(tc, 'b')).toEqual(['urgent']);
          expect((await record('a')).title).toBe('Alpha');
          if (embedded) expect((await record('b')).tags).toEqual(['urgent']);
        },
      );
    });

    it('deleteGroup of an unknown group fails as notFound', async () => {
      const r = await tc.deleteGroup('nope');
      expect(r.failed).toMatchObject([{ id: 'nope', code: 'notFound' }]);
    });

    it('mergeGroups: memberships re-pointed (no duplicates), the merged group deleted', async () => {
      await tc.tag(['c'], 'todo');
      await undoable(
        tc,
        () => tc.mergeGroups('work', 'urgent'),
        async () => {
          expect(tc.space().nodes.has('work' as never)).toBe(false);
          expect(groupsOf(tc, 'a')).toEqual(['urgent']);
          expect(groupsOf(tc, 'b')).toEqual(['urgent']); // was in both: once
          expect(groupsOf(tc, 'c')).toEqual(['todo']);
          if (embedded) {
            expect((await record('a')).tags).toEqual(['urgent']);
            expect((await record('b')).tags).toEqual(['urgent']);
          }
        },
      );
    });

    it('renameGroup by id: the members follow, in place', async () => {
      await undoable(
        tc,
        () => tc.renameGroup('work', 'job', { by: 'id' }),
        async (r) => {
          expect(r.ok).toBe(true);
          expect(tc.space().nodes.has('work' as never)).toBe(false);
          expect(groupsOf(tc, 'a')).toEqual(['job']);
          expect(groupsOf(tc, 'b')).toEqual(['job', 'urgent']);
          if (embedded) expect((await record('b')).tags).toEqual(['job', 'urgent']); // took work's place
        },
      );
    });

    it('renameGroup to an existing group is refused (that is a merge)', async () => {
      const r = await tc.renameGroup('work', 'urgent', { by: 'id' });
      expect(r.failed).toMatchObject([{ id: 'work', code: 'groupExists' }]);
    });

    if (embedded) {
      it('renameGroup by label is refused: the field stores ids', async () => {
        await expect(tc.renameGroup('work', 'Work', { by: 'label' })).rejects.toThrow(/rename by id/);
      });
    } else {
      it('renameGroup by label (the store default): the id and every edge stay', async () => {
        await undoable(
          tc,
          () => tc.renameGroup('work', 'Work & Career'),
          () => {
            expect(tc.space().nodes.get('work' as never)?.label).toBe('Work & Career');
            expect(groupsOf(tc, 'a')).toEqual(['work']);
          },
        );
      });

      it('a rename undone after someone renamed again is refused, not overwritten', async () => {
        const r = await tc.renameGroup('work', 'Work');
        await tc.renameGroup('work', 'Job');
        const undo = await tc.revert(r.inverse);
        expect(undo.ok).toBe(false);
        expect(undo.failed[0]).toMatchObject({ code: 'conflict' });
        expect(undo.failed[0]!.reason).toMatch(/changed since/);
        expect(tc.space().nodes.get('work' as never)?.label).toBe('Job');
      });

      it('tag with an edge kind (store spaces only)', async () => {
        const r = await tc.tag(['c'], 'work', { kind: 'is_a' });
        expect(r.ok).toBe(true);
        expect([...tc.space().edges.values()].some((e) => e.child === 'c' && e.kind === 'is_a')).toBe(true);
      });
    }

    it('several operations undone in reverse order (as an app history does) restore the start', async () => {
      const start = await state(tc);
      const steps = [
        await tc.tag(['a', 'c'], 'urgent'),
        await tc.create({ id: 'e', title: 'Epsilon' }, { groups: ['urgent'] }),
        await tc.mergeGroups('urgent', 'work'),
        await tc.deleteItem('a'),
        await tc.untag(['b'], 'work'),
      ];
      for (const s of steps) expect(s.failed).toEqual([]);
      for (const s of steps.reverse()) expect((await tc.revert(s.inverse)).failed).toEqual([]);
      expect(await state(tc)).toEqual(start);
    });
  });
}
