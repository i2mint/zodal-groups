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

  it('rolls back only its own edit when another write landed in between', async () => {
    const g = build();
    const first = deferred();
    const writes = [first.promise, Promise.resolve()];
    renderTagInput(container, g, { onWrite: () => writes.shift()! }).show(nodeId('msg-1'));

    type('urgent');
    type('later');
    first.reject(new Error('conflict'));
    await flush();
    expect([...g.parents('msg-1')].sort()).toEqual(['later', 'work']);
    expect(chips().sort()).toEqual(['later', 'work']);
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
