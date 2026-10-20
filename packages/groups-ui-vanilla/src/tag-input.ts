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
 *
 * **Typing never creates a group by accident.** The field is a combobox: as you type it lists the
 * matching groups, and, when no group has that exact name, an explicit **Create “…”** option. Enter
 * picks the group the text names (case-insensitively), or the only group it is a prefix of; with no
 * match it says so and creates nothing. Creating is choosing that option (arrow to it, or tap it),
 * so a typo ("Campf") picks "Campfire" or asks, and never quietly becomes a new group. A group's
 * other names (`alias_of`, D34) match too: typing `to-do` offers `todo`, once, and Enter picks it. The field is
 * built once and never re-rendered: what you are typing, and focus, survive every redraw.
 */

import {
  edgesInto,
  aliasMap,
  edgesOf,
  invert,
  isGroup,
  nodeId,
  type EdgeDelta,
  type Groups,
  type GroupSpace,
  type NodeId,
  type Result,
} from '@zodal/groups-core';
import { toTagTokens } from '@zodal/groups-ui';

export interface TagInputRenderer {
  show(item: NodeId): void;
  destroy(): void;
  readonly element: HTMLElement;
}

/** The words the tag input uses. Override any of them (translation, house style). */
export interface TagInputLabels {
  readonly placeholder: string;
  readonly inputLabel: string;
  readonly suggestions: string;
  readonly create: (text: string) => string;
  readonly noMatch: (text: string) => string;
  readonly ambiguous: (text: string, count: number) => string;
  readonly alreadyIn: (group: string) => string;
}

export const TAG_INPUT_LABELS: TagInputLabels = {
  placeholder: 'Add to group…',
  inputLabel: 'Add to group',
  suggestions: 'Groups',
  create: (text) => `Create “${text}”`,
  noMatch: (text) => `No group is called “${text}”. Choose Create to make one.`,
  ambiguous: (text, count) => `${count} groups start with “${text}”: choose one.`,
  alreadyIn: (group) => `Already in “${group}”.`,
};

export interface TagInputOptions {
  /** How many matching groups to list. Default 8. */
  readonly maxSuggestions?: number;
  readonly labels?: Partial<TagInputLabels>;
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

let instances = 0;

export function renderTagInput<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: TagInputOptions = {},
): TagInputRenderer {
  const { maxSuggestions = 8 } = options;
  const labels = { ...TAG_INPUT_LABELS, ...options.labels };
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
        // And only if nobody wrote while the undo notified (a host listener): then the top is theirs.
        clean =
          !!below &&
          entry.before.revision === below.revision &&
          entry.depthBefore === below.depth &&
          groups.undoDepth === entry.depthBefore;
        continue;
      }
      clean = false;
      // Only what is not already undone (#17): the host may have undone this edit itself, and
      // re-adding an edge that exists would be refused and reported as a failed rollback.
      const inverse = invert(entry.before, entry.delta);
      const space = groups.space;
      const added = (inverse.added ?? []).filter(
        (e) => !space.edges.has(e.id) && !edgesInto(space, e.child).some((x) => x.parent === e.parent && x.kind === e.kind),
      );
      const removed = (inverse.removed ?? []).filter((id) => space.edges.has(id));
      if (!added.length && !removed.length) continue;
      // A node the edit created goes again only if nothing else uses it now: another item may have
      // joined a group this edit created, and a tombstone for a node with edges is refused.
      const going = new Set(removed);
      const unused = (id: NodeId): boolean =>
        space.nodes.has(id) && ![...edgesOf(space, id), ...edgesInto(space, id)].some((e) => !going.has(e.id));
      const remaining: EdgeDelta = {
        ...inverse,
        added,
        removed,
        ...(inverse.removedNodes ? { removedNodes: inverse.removedNodes.filter((n) => unused(n.id)) } : {}),
        ...(inverse.addedNodes ? { addedNodes: inverse.addedNodes.filter((n) => !space.nodes.has(n.id)) } : {}),
      };
      const depth = groups.undoDepth;
      if (!groups.apply(remaining).ok) ok = false;
      // A rollback is not an edit (#19): left on the history, the next Undo would re-apply the very
      // edit `onWrite` rejected, and `onWrite` would never hear of it. Drop it only when it is the
      // top entry: a host listener that wrote during the apply's notification owns the top then,
      // and dropping theirs would be worse than keeping ours.
      else if (groups.undoDepth === depth + 1) groups.discardUndo();
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
        // Redraw first: a host callback that throws must not leave the screen stale.
        if (!destroyed) render();
        options.onChange?.();
        options.onError?.(error, { delta: head.delta, discarded: failed.slice(1).map((p) => p.delta), rolledBack });
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

  // ── the field: built once, never re-rendered (#19: typed text and focus survive redraws) ──
  const uid = `zg-tags-${++instances}`;
  const field = document.createElement('span');
  field.className = 'zg-tag-field';
  const input = document.createElement('input');
  input.className = 'zg-tag-input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = labels.placeholder;
  input.setAttribute('aria-label', labels.inputLabel);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${uid}-list`);
  const list = document.createElement('ul');
  list.className = 'zg-tag-suggestions';
  list.id = `${uid}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', labels.suggestions);
  list.hidden = true;
  field.append(input, list);
  root.insertBefore(field, status);

  /** What an option does when chosen. */
  type Option =
    | { readonly kind: 'group'; readonly id: NodeId; readonly label: string; readonly path?: string; readonly alias?: string }
    | { readonly kind: 'create'; readonly text: string };
  let choices: Option[] = [];
  let active = -1;
  /** Bumped on every list render, so an option id never points at a different node (aria-activedescendant). */
  let generation = 0;

  const norm = (text: string): string => text.trim().toLocaleLowerCase();

  /** The groups the typed text could mean, best first, and which one Enter would pick. */
  const match = (text: string, current: NodeId) => {
    const q = norm(text);
    const space = groups.space;
    const member = new Set(groups.parents(current));
    // Each group with its other names (`alias_of`): a match through one is shown on the group, once,
    // and an alias is never offered itself (a tag goes to the canonical group, D34).
    const aliases = aliasMap(space);
    const aliasIds = new Set([...aliases.values()].flat());
    const namesOf = (id: NodeId) => (aliases.get(id) ?? []).flatMap((a) => [nameOf(a), a]);
    const all = [...space.nodes.keys()]
      .filter((id) => id !== current && isGroup(space, id) && !aliasIds.has(id))
      .map((id) => ({ id, label: nameOf(id), aliases: namesOf(id) }));
    // The canonical node a typed alias names, whether or not it is offered (an empty vocabulary node).
    const named = [...aliases].find(([, names]) => names.some((a) => norm(a) === q || norm(nameOf(a)) === q))?.[0];
    /** `g` when its label passes `test`, else `g` with the first alias that does, else `null`. */
    const via = (g: (typeof all)[number], test: (name: string) => boolean) => {
      if (test(norm(g.label))) return g;
      const alias = g.aliases.find((a) => test(norm(a)));
      return alias === undefined ? null : { ...g, alias };
    };
    const exact =
      all.find((g) => norm(g.label) === q) ??
      all.find((g) => norm(g.id) === q) ??
      all.map((g) => via(g, (n) => n === q)).find((g) => g !== null) ??
      (named !== undefined && named !== current
        ? { id: named, label: nameOf(named), aliases: namesOf(named), alias: aliases.get(named)!.find((a) => norm(a) === q || norm(nameOf(a)) === q)! }
        : undefined);
    // Prefixes count among the groups it could join: one it is already in cannot be picked.
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    const prefixed = all
      .filter((g) => !member.has(g.id))
      .map((g) => via(g, (n) => n.startsWith(q)))
      .filter((g): g is NonNullable<typeof g> => g !== null)
      .sort(byLabel);
    const prefixedIds = new Set(prefixed.map((g) => g.id));
    const containing = all
      .filter((g) => !prefixedIds.has(g.id))
      .map((g) => via(g, (n) => n.includes(q)))
      .filter((g): g is NonNullable<typeof g> => g !== null)
      .sort(byLabel);
    // One entry per group, the first (best) one: an exact match keeps the alias it matched by.
    const firstById = new Map<NodeId, (typeof prefixed)[number]>();
    for (const g of [...(exact ? [exact] : []), ...prefixed, ...containing]) if (!firstById.has(g.id)) firstById.set(g.id, g);
    const offered = [...firstById.values()]
      .filter((g) => !member.has(g.id))
      .slice(0, maxSuggestions);
    // Enter picks the group the text names, or the only one it is a prefix of. Never a guess.
    const pick = exact ?? (prefixed.length === 1 ? prefixed[0] : undefined);
    // (`exact` may be a group it is already in: Enter then says so instead of picking.)
    return { offered, exact, prefixed, pick, member, named: named !== undefined };
  };

  const pathOf = (id: NodeId): string | undefined => {
    const path = groups.path(id);
    return path && path.labels.length > 1 ? path.labels.join('/') : undefined;
  };

  const setActive = (index: number): void => {
    active = index;
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
      const on = i === active;
      items[i]!.classList.toggle('is-active', on);
      items[i]!.setAttribute('aria-selected', String(on));
    }
    if (active >= 0 && items[active]) input.setAttribute('aria-activedescendant', items[active]!.id);
    else input.removeAttribute('aria-activedescendant');
  };

  const closeList = (): void => {
    choices = [];
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const refreshList = (): void => {
    const text = input.value.trim();
    if (!item || !text) return closeList();
    const { offered, exact, pick, named } = match(text, item);
    choices = [
      ...offered.map((g): Option => {
        const path = pathOf(g.id);
        const alias = 'alias' in g ? (g.alias as string) : undefined;
        return { kind: 'group', id: g.id, label: g.label, ...(path ? { path } : {}), ...(alias ? { alias } : {}) };
      }),
      ...(exact || named ? [] : [{ kind: 'create', text } as const]),
    ];
    generation += 1;
    list.replaceChildren(
      ...choices.map((option, i) => {
        const li = document.createElement('li');
        li.id = `${uid}-${generation}-${i}`; // positional, never from the group id
        li.setAttribute('role', 'option');
        li.className = option.kind === 'create' ? 'zg-tag-option zg-tag-create' : 'zg-tag-option';
        li.textContent = option.kind === 'create' ? labels.create(option.text) : option.label;
        if (option.kind === 'group' && option.alias) {
          const alias = document.createElement('span');
          alias.className = 'zg-tag-option-alias';
          alias.textContent = option.alias;
          li.appendChild(alias);
        }
        if (option.kind === 'group' && option.path) {
          const path = document.createElement('span');
          path.className = 'zg-tag-option-path';
          path.textContent = option.path;
          li.appendChild(path);
        }
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
        li.addEventListener('click', () => choose(option));
        return li;
      }),
    );
    list.hidden = !choices.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    // The default highlight is the group Enter would pick; the Create option is never preselected.
    setActive(pick ? choices.findIndex((o) => o.kind === 'group' && o.id === pick.id) : -1);
  };

  const choose = (option: Option): void => {
    if (!item) return;
    const current = item;
    const tag = option.kind === 'group' ? option.id : nodeId(option.text);
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
    closeList();
    options.onChange?.();
    render();
    input.focus();
  };

  /** Enter with nothing highlighted: say why nothing happened, create nothing. */
  const explain = (text: string, current: NodeId): void => {
    const { pick, prefixed, member } = match(text, current);
    if (pick && member.has(pick.id)) {
      status.textContent = labels.alreadyIn(pick.label);
      input.value = '';
      closeList();
    } else if (prefixed.length > 1) {
      status.textContent = labels.ambiguous(text, prefixed.length);
    } else {
      status.textContent = labels.noMatch(text);
    }
  };

  input.addEventListener('input', () => {
    input.setCustomValidity('');
    refreshList();
  });

  input.addEventListener('keydown', (e) => {
    if (!item) return;
    const n = choices.length;
    switch (e.key) {
      case 'ArrowDown':
        if (list.hidden) refreshList();
        else if (n) setActive((active + 1) % n);
        break;
      case 'ArrowUp':
        if (n) setActive(active <= 0 ? n - 1 : active - 1);
        break;
      case 'Enter': {
        if (e.isComposing || e.keyCode === 229) return; // an IME is composing: Enter is theirs
        const text = input.value.trim();
        if (!text) return;
        if (list.hidden) refreshList(); // the text was set without an `input` event
        const option = choices[active];
        if (option) choose(option);
        else explain(text, item);
        break;
      }
      case 'Escape':
        // APG: the first Escape closes the list, the second clears the field.
        if (!list.hidden) closeList();
        else if (input.value) input.value = '';
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  input.addEventListener('blur', () => closeList());

  const render = (): void => {
    const hadFocus = body.contains(document.activeElement);
    if (!item) {
      body.replaceChildren();
      field.hidden = true;
      return;
    }
    field.hidden = false;
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

    body.replaceChildren(...chips);
    // A chip button that had focus is gone: the field is the next place to be.
    if (hadFocus) input.focus();
  };

  return {
    show(next) {
      if (next !== item) {
        input.value = '';
        closeList();
      }
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
