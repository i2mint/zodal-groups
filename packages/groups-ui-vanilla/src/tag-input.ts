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
 * once (optimistic), then handed to `onWrite` as the exact `EdgeDelta`. If it rejects, the edit is
 * rolled back — by `undo()` when nothing was written since, by its inverse otherwise — and the
 * reason is announced in the input's live status.
 */

import { invert, type EdgeDelta, type Groups, type GroupSpace, type NodeId, type Result } from '@zodal/groups-core';
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
   * resolve to keep it, reject (or throw) to roll it back.
   */
  readonly onWrite?: (delta: EdgeDelta) => Promise<void> | void;
  /** Called when `onWrite` rejected, after the rollback (`rolledBack: false` if it was refused). */
  readonly onError?: (error: unknown, context: { readonly delta: EdgeDelta; readonly rolledBack: boolean }) => void;
}

export function renderTagInput<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: TagInputOptions = {},
): TagInputRenderer {
  let item: NodeId | null = null;
  let destroyed = false;
  let pending = 0;

  const root = document.createElement('div');
  root.className = 'zg-tags';
  container.appendChild(root);

  // Lives across re-renders, so an announcement is not wiped by the render that follows it.
  const status = document.createElement('span');
  status.className = 'zg-tag-status';
  status.setAttribute('role', 'status');

  /** Apply locally, then persist; roll back if persisting fails. Returns the local result. */
  const write = (op: () => Result<GroupSpace<P>>): Result<GroupSpace<P>> => {
    const before = groups.space;
    let delta: EdgeDelta | undefined;
    const off = groups.subscribe((change) => {
      delta ??= change.delta;
    });
    let result: Result<GroupSpace<P>>;
    try {
      result = op();
    } finally {
      off();
    }
    if (!result.ok || !delta) return result;
    status.textContent = '';
    if (!options.onWrite) return result;

    const committed = delta;
    const after = groups.revision;
    pending += 1;
    root.setAttribute('aria-busy', 'true');
    void (async () => {
      try {
        await options.onWrite!(committed);
      } catch (error) {
        // Nothing written since: undo pops our own history entry. Otherwise apply the inverse,
        // computed against the space our delta was applied to.
        const rolledBack =
          (groups.revision === after && groups.undo()) || groups.apply(invert(before, committed)).ok;
        const reason = error instanceof Error ? error.message : String(error);
        status.textContent = rolledBack ? `Not saved: ${reason}` : `Not saved, and could not be undone: ${reason}`;
        options.onChange?.();
        options.onError?.(error, { delta: committed, rolledBack });
        if (!destroyed) render();
      } finally {
        pending -= 1;
        if (!pending) root.removeAttribute('aria-busy');
      }
    })();
    return result;
  };

  const render = (): void => {
    if (!item) {
      root.replaceChildren();
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
        write(() => groups.remove(current, token.nodeId));
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
      const result = write(() => groups.add(current, input.value.trim()));
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

    root.replaceChildren(...chips, input, status);
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
