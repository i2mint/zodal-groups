/**
 * A vanilla tag input — the flat-tagging surface over the very same edges.
 *
 * Worth pausing on: this renderer and `renderTree` read the *same relation*. A chip row and a folder
 * tree are two projections of one edge set, and switching between them changes no data. That is the
 * thesis, reduced to two files in the same package.
 *
 * Suggestions show the full path (`animal/dog/poodle`) so a hierarchical tag stays legible in a flat
 * control — which is what the string-based systems (Obsidian, Bear) get right, even though their
 * *storage* of nesting as a string is what makes their polyhierarchy impossible.
 *
 * Persisting is the host's: pass `onWrite`, and every edit is applied to the in-memory `Groups` at
 * once (optimistic) and handed to `onWrite` as its exact `EdgeDelta`. Writes go out **one at a
 * time, in order**: a later edit may be built on an earlier one (add a tag, then remove it), so when
 * a write rejects, that edit *and every queued edit after it* are rolled back, newest first, and
 * the queued ones are never sent. The reason is announced in the input's live status.
 */

import { invert, nodeId, type EdgeDelta, type Groups, type GroupSpace, type NodeId, type Result } from '@zodal/groups-core';
import { toTagTokens } from '@zodal/groups-ui';

export interface TagInputRenderer {
  show(item: NodeId): void;
  destroy(): void;
  readonly element: HTMLElement;
}

export interface TagInputOptions {
  /** Called after every change to the model: an edit, and a rollback of one. */
  readonly onChange?: () => void;
  /**
   * Persist an edit, e.g. PATCH a server. Receives the delta that was just applied locally;
   * resolve to keep it, reject (or throw) to roll it back. Called one edit at a time, in order.
   */
  readonly onWrite?: (delta: EdgeDelta) => Promise<void> | void;
  /**
   * Called when `onWrite` rejected, after the rollback. `discarded` are the later edits that were
   * waiting behind it, rolled back too and never sent; `rolledBack: false` if any part of the
   * rollback was refused (the model changed underneath in a way that conflicts).
   */
  readonly onError?: (
    error: unknown,
    context: { readonly delta: EdgeDelta; readonly discarded: readonly EdgeDelta[]; readonly rolledBack: boolean },
  ) => void;
}

/** An optimistic edit, applied locally, whose write has not succeeded yet. */
interface Pending<P> {
  readonly delta: EdgeDelta;
  /** The space the delta was applied to: what `invert` needs. */
  readonly before: GroupSpace<P>;
  /** The revision our commit produced, and the undo depth right after it. */
  readonly revision: number;
  readonly depth: number;
  /** The undo depth before it: tells whether the previous pending edit sits right under it. */
  readonly depthBefore: number;
}

export function renderTagInput<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: TagInputOptions = {},
): TagInputRenderer {
  let item: NodeId | null = null;
  let destroyed = false;
  /** Oldest first; `queue[0]` is the one being written while `writing` is true. */
  const queue: Pending<P>[] = [];
  let writing = false;

  const root = document.createElement('div');
  root.className = 'zg-tags';
  container.appendChild(root);

  // Chips and input are re-rendered; the status is not, so an announcement is never detached
  // from the page right after it is set (some screen readers would skip it).
  const body = document.createElement('span');
  body.className = 'zg-tags-body';
  const status = document.createElement('span');
  status.className = 'zg-tag-status';
  status.setAttribute('role', 'status');
  root.append(body, status);

  const nameOf = (id: NodeId): string => groups.space.nodes.get(id)?.label ?? id;
  const describe = (p: Pending<P>): string => {
    const added = (p.delta.added ?? []).map((e) => `adding “${nameOf(e.parent)}”`);
    const removed = (p.delta.removed ?? []).map((id) => {
      const edge = p.before.edges.get(id);
      return edge ? `removing “${nameOf(edge.parent)}”` : 'a removal';
    });
    return [...added, ...removed].join(', ') || 'an edit';
  };

  /** Undo `entries` (oldest first) newest first. `undo()` while nothing else was written since. */
  const rollBack = (entries: readonly Pending<P>[]): boolean => {
    let ok = true;
    // `clean`: the top of the undo history is still this entry's own commit.
    let clean = (() => {
      const newest = entries[entries.length - 1]!;
      return groups.revision === newest.revision && groups.undoDepth === newest.depth;
    })();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (clean && groups.undo()) {
        const below = entries[i - 1];
        // The entry below is next on the history only if this one was committed right on top of it.
        clean = !!below && entry.before.revision === below.revision && entry.depthBefore === below.depth;
        continue;
      }
      clean = false;
      if (!groups.apply(invert(entry.before, entry.delta)).ok) ok = false;
    }
    return ok;
  };

  const pump = (): void => {
    if (writing || !queue.length || !options.onWrite) return;
    writing = true;
    root.setAttribute('aria-busy', 'true');
    const head = queue[0]!;
    void (async () => {
      try {
        await options.onWrite!(head.delta);
        queue.shift();
      } catch (error) {
        // Everything queued was built on `head`: none of it may stay, and none of it is sent.
        const failed = queue.splice(0);
        const rolledBack = rollBack(failed);
        const reason = error instanceof Error ? error.message : String(error);
        status.textContent = `${rolledBack ? 'Not saved' : 'Not saved, and could not be undone'} (${describe(head)}): ${reason}`;
        options.onChange?.();
        options.onError?.(error, { delta: head.delta, discarded: failed.slice(1).map((p) => p.delta), rolledBack });
        if (!destroyed) render();
      } finally {
        writing = false;
        if (!queue.length) root.removeAttribute('aria-busy');
        pump();
      }
    })();
  };

  /**
   * Apply locally, queue the write. Returns the local result.
   *
   * `isOurs` picks our commit out of the notices `op` causes: a host listener that writes from
   * inside its callback commits too, and its notice may reach us first (with the later revision).
   */
  const write = (
    op: () => Result<GroupSpace<P>>,
    isOurs: (delta: EdgeDelta, before: GroupSpace<P>) => boolean,
  ): Result<GroupSpace<P>> => {
    const before = groups.space;
    const depthBefore = groups.undoDepth;
    let delta: EdgeDelta | undefined;
    const off = groups.subscribe((change) => {
      if (!delta && isOurs(change.delta, before)) delta = change.delta;
    });
    let result: Result<GroupSpace<P>>;
    try {
      result = op();
    } finally {
      off();
    }
    if (!result.ok || !delta) return result;
    status.textContent = '';
    if (options.onWrite) {
      // Every commit adds exactly one revision and one undo entry, so this is the state right
      // after ours — which `rollBack` compares with, to know nothing else was written since.
      queue.push({ delta, before, depthBefore, revision: before.revision + 1, depth: depthBefore + 1 });
      pump();
    }
    return result;
  };

  const render = (): void => {
    if (!item) {
      body.replaceChildren();
      return;
    }
    const current = item;
    const tokens = toTagTokens(groups, current);

    const chips = tokens.map((token) => {
      const chip = document.createElement('span');
      chip.className = 'zg-chip';

      const text = document.createElement('span');
      text.textContent = token.path ?? token.label;
      chip.appendChild(text);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'zg-chip-remove';
      remove.textContent = '×';
      // Remove ≠ delete. The item survives, and so do its other memberships.
      remove.setAttribute('aria-label', `Remove from ${token.label}`);
      remove.addEventListener('click', () => {
        write(
          () => groups.remove(current, token.nodeId),
          (d, before) =>
            (d.removed ?? []).some((id) => {
              const edge = before.edges.get(id);
              return edge?.child === current && edge.parent === token.nodeId;
            }),
        );
        options.onChange?.();
        render();
      });
      chip.appendChild(remove);
      return chip;
    });

    const input = document.createElement('input');
    input.className = 'zg-tag-input';
    input.placeholder = 'Add to group…';
    input.setAttribute('aria-label', 'Add to group');
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const tag = nodeId(input.value.trim());
      const result = write(
        () => groups.add(current, tag),
        (d) => (d.added ?? []).some((e) => e.child === current && e.parent === tag),
      );
      if (!result.ok) {
        input.setCustomValidity(result.violations[0]!.message);
        input.reportValidity();
        return;
      }
      input.value = '';
      input.setCustomValidity('');
      options.onChange?.();
      render();
      input.focus();
    });

    body.replaceChildren(...chips, input);
  };

  return {
    show(next) {
      item = next;
      render();
    },
    element: root,
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}
