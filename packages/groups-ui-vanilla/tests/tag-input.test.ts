/**
 * `renderTagInput`'s persistence hook (issue #11): an edit is applied at once, handed to `onWrite`
 * as its exact delta, and rolled back if `onWrite` rejects.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, nodeId, type EdgeDelta } from '@zodal/groups-core';
import { renderTagInput } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const build = () => {
  const g = defineGroups({ profile: 'labels' });
  g.add('msg-1', 'work');
  return g;
};

/** A promise the test settles by hand, standing in for a server round trip. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const type = (value: string) => {
  const input = container.querySelector<HTMLInputElement>('.zg-tag-input')!;
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
};
const chips = () => [...container.querySelectorAll('.zg-chip')].map((c) => c.firstChild!.textContent);
const status = () => container.querySelector('[role="status"]')!.textContent;

describe('renderTagInput onWrite', () => {
  it('applies at once, hands over the exact delta, and keeps the edit when the write resolves', async () => {
    const g = build();
    const seen: EdgeDelta[] = [];
    const server = deferred();
    renderTagInput(container, g, { onWrite: (d) => (seen.push(d), server.promise) }).show(nodeId('msg-1'));

    type('urgent');
    expect(chips()).toEqual(['work', 'urgent']); // optimistic
    expect(seen).toHaveLength(1);
    expect(seen[0]!.added!.map((e) => [e.child, e.parent])).toEqual([['msg-1', 'urgent']]);
    expect(container.querySelector('.zg-tags')!.getAttribute('aria-busy')).toBe('true');

    server.resolve();
    await flush();
    expect(chips()).toEqual(['work', 'urgent']);
    expect(container.querySelector('.zg-tags')!.hasAttribute('aria-busy')).toBe(false);
  });

  it('rolls an add back when the write rejects, and says why', async () => {
    const g = build();
    const depth = g.undoDepth;
    const errors: Array<{ rolledBack: boolean }> = [];
    renderTagInput(container, g, {
      onWrite: () => Promise.reject(new Error('503')),
      onError: (_e, ctx) => errors.push(ctx),
    }).show(nodeId('msg-1'));

    type('urgent');
    await flush();
    expect(chips()).toEqual(['work']);
    expect(g.parents('msg-1')).toEqual(['work']);
    expect(g.undoDepth).toBe(depth); // undo popped our own entry: no stray history
    expect(status()).toContain('503');
    expect(errors).toEqual([expect.objectContaining({ rolledBack: true })]);
  });

  it('rolls a removal back, restoring the membership', async () => {
    const g = build();
    renderTagInput(container, g, {
      onWrite: () => {
        throw new Error('offline'); // a synchronous throw counts as a rejection
      },
    }).show(nodeId('msg-1'));

    container.querySelector<HTMLElement>('.zg-chip-remove')!.click();
    await flush();
    expect(chips()).toEqual(['work']);
    expect(status()).toContain('offline');
  });

  it('rolls back only its own edit when the host wrote in between', async () => {
    const g = build();
    const server = deferred();
    renderTagInput(container, g, { onWrite: () => server.promise }).show(nodeId('msg-1'));

    type('urgent');
    g.add('msg-1', 'other'); // a write that is not the input's
    server.reject(new Error('conflict'));
    await flush();
    expect([...g.parents('msg-1')].sort()).toEqual(['other', 'work']);
  });

  it('sends one write at a time; a failure rolls back the queued edits built on it, unsent', async () => {
    // Review of PR #16: add `x` then remove it, both pending, the add rejecting first, used to
    // leave `x` on screen (the removal's inverse re-added it) while the server held neither.
    const g = build();
    const first = deferred();
    const sent: EdgeDelta[] = [];
    const errors: Array<{ discarded: readonly EdgeDelta[]; rolledBack: boolean }> = [];
    const depth = g.undoDepth;
    renderTagInput(container, g, {
      onWrite: (d) => (sent.push(d), first.promise),
      onError: (_e, ctx) => errors.push(ctx),
    }).show(nodeId('msg-1'));

    type('x');
    [...container.querySelectorAll<HTMLElement>('.zg-chip-remove')].at(-1)!.click(); // remove `x`
    expect(g.parents('msg-1')).toEqual(['work']);
    expect(sent).toHaveLength(1); // the removal waits behind the add

    first.reject(new Error('503'));
    await flush();
    expect(g.parents('msg-1')).toEqual(['work']);
    expect(chips()).toEqual(['work']);
    expect(sent).toHaveLength(1); // never sent
    expect(errors).toEqual([expect.objectContaining({ rolledBack: true, discarded: [expect.objectContaining({ removed: expect.any(Array) })] })]);
    expect(g.undoDepth).toBe(depth); // both undone by undo(): no stray history
    expect(status()).toContain('“x”');
  });

  it('sends the next write once the previous one succeeded', async () => {
    const g = build();
    const replies = [deferred(), deferred()];
    const sent: EdgeDelta[] = [];
    renderTagInput(container, g, { onWrite: (d) => (sent.push(d), replies[sent.length - 1]!.promise) }).show(nodeId('msg-1'));
    type('a');
    type('b');
    expect(sent).toHaveLength(1);
    replies[0]!.resolve();
    await flush();
    expect(sent).toHaveLength(2);
    replies[1]!.reject(new Error('no'));
    await flush();
    expect([...g.parents('msg-1')].sort()).toEqual(['a', 'work']); // only `b` rolled back
  });

  it('hands over its own delta even when a host listener writes from inside its callback', async () => {
    const g = build();
    g.subscribe((change) => {
      if (change.delta.added?.some((e) => e.parent === 'urgent')) g.add('msg-2', 'seen');
    });
    const sent: EdgeDelta[] = [];
    renderTagInput(container, g, { onWrite: (d) => (sent.push(d), Promise.reject(new Error('no'))) }).show(nodeId('msg-1'));
    type('urgent');
    expect(sent[0]!.added!.map((e) => e.parent)).toEqual(['urgent']);
    await flush();
    expect(g.parents('msg-1')).toEqual(['work']); // ours rolled back...
    expect(g.parents('msg-2')).toEqual(['seen']); // ...the host's kept
  });

  it('does not undo someone else\'s edit after the host discarded history', async () => {
    const g = build();
    g.add('msg-9', 'keep');
    const server = deferred();
    renderTagInput(container, g, { onWrite: () => server.promise }).show(nodeId('msg-1'));
    type('x');
    g.discardUndo(); // drops the input's own entry; the top is now `msg-9 → keep`
    server.reject(new Error('no'));
    await flush();
    expect(g.parents('msg-1')).toEqual(['work']);
    expect(g.parents('msg-9')).toEqual(['keep']);
  });

  it('keeps focus in the input after adding a tag', () => {
    const g = build();
    renderTagInput(container, g).show(nodeId('msg-1'));
    type('urgent');
    expect(document.activeElement).toBe(container.querySelector('.zg-tag-input'));
  });

  it('a refused edit never reaches onWrite', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('file', 'a');
    let calls = 0;
    renderTagInput(container, g, { onWrite: () => void (calls += 1) }).show(nodeId('file'));
    type('b'); // filesystem: one parent only
    expect(calls).toBe(0);
  });

  it('still rolls the model back when the renderer was destroyed meanwhile', async () => {
    const g = build();
    const server = deferred();
    const r = renderTagInput(container, g, { onWrite: () => server.promise });
    r.show(nodeId('msg-1'));
    type('urgent');
    r.destroy();
    server.reject(new Error('gone'));
    await flush();
    expect(g.parents('msg-1')).toEqual(['work']);
  });
});
