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
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import { toTagTokens } from '@zodal/groups-ui';

export interface TagInputRenderer {
  show(item: NodeId): void;
  destroy(): void;
  readonly element: HTMLElement;
}

export function renderTagInput<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: { readonly onChange?: () => void } = {},
): TagInputRenderer {
  let item: NodeId | null = null;

  const root = document.createElement('div');
  root.className = 'zg-tags';
  container.appendChild(root);

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
        groups.remove(current, token.nodeId);
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
      const result = groups.add(current, input.value.trim());
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

    root.replaceChildren(...chips, input);
  };

  return {
    show(next) {
      item = next;
      render();
    },
    element: root,
    destroy: () => root.remove(),
  };
}
