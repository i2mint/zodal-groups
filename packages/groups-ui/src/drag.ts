/**
 * The drag-and-drop intent model — the most dangerous interaction in the whole library.
 *
 * In a tree, dragging is unambiguous: it moves. Under polyhierarchy there are *two* plausible
 * meanings, they look identical mid-drag, and they differ in whether data disappears:
 *
 * - **ADD** — give the node another parent. It is now in both places. Nothing is lost.
 * - **MOVE** — remove it from where it was and put it here. **An edge is destroyed.**
 *
 * We invert the Finder convention deliberately: **ADD is the default; MOVE requires a modifier.**
 * Three reasons, in increasing order of importance:
 *
 * 1. MOVE destroys an edge the user often *cannot see* — the source group may be off-screen, or the
 *    node may have five other parents.
 * 2. MOVE is literally **undefined** when the drag starts from a search result, a facet panel, or a
 *    flat "all items" list, because there is no source group to remove from. ADD always has a
 *    meaning.
 * 3. The undo cost is asymmetric: an accidental ADD is a visible, obvious, one-click mistake. An
 *    accidental MOVE silently removes something from a folder the user wasn't looking at.
 *
 * Gmail is the precedent, and it solves the ambiguity by refusing to have it: two separate verbs,
 * `Label` and `Move to`. When you have room for two buttons, use two buttons.
 *
 * This module is pure: it computes an *intent* from a gesture and validates it against the model.
 * It never touches the DOM. Renderers map their library's drag events onto `DragGesture` and render
 * the returned `DropTarget` — which is why the same logic drives shadcn, vanilla, and Ark.
 *
 * @see `docs/research/_reconciliation.md` — D15, D16.
 */

import {
  canAddTo,
  type Groups,
  type NodeId,
  type PathNode,
  type Violation,
} from '@zodal/groups-core';

/** What the user is doing, expressed independently of any drag library. */
export interface DragGesture {
  /** The row being dragged. Its `path` tells us which parent it is being dragged *out of*. */
  readonly source: PathNode;
  /** The row being hovered. */
  readonly target: PathNode;
  /** Held modifier keys. `alt` (⌥) switches ADD → MOVE. */
  readonly modifiers?: { readonly alt?: boolean; readonly shift?: boolean; readonly meta?: boolean };
  /** Where in the target row the pointer is — drives reorder vs. reparent. */
  readonly position?: 'before' | 'after' | 'inside';
}

export type DropOperation =
  /** Add a parent. The node ends up in both places. The safe default. */
  | { readonly type: 'add'; readonly child: NodeId; readonly parent: NodeId }
  /** Move between parents. Destructive — requires a modifier. */
  | { readonly type: 'move'; readonly child: NodeId; readonly from: NodeId; readonly to: NodeId }
  /** Reorder within the same parent. */
  | { readonly type: 'reorder'; readonly child: NodeId; readonly parent: NodeId; readonly before?: NodeId; readonly after?: NodeId };

/**
 * The renderer's instruction. Always renderable — an invalid drop still produces a target, carrying
 * the *reason*, so the UI can explain itself rather than just refusing.
 */
export interface DropTarget {
  readonly operation: DropOperation | null;
  readonly valid: boolean;
  /**
   * Why the drop is refused, in a sentence a user can act on.
   *
   * This is not a nicety. Under polyhierarchy a cycle can close through a branch that is not on
   * screen, so a drop target that simply refuses is **indistinguishable from a bug**. The model
   * gives us the offending path, so we can say: *"Reading is already inside Archive → Research →
   * Reading."*
   */
  readonly reason?: string;
  readonly violations: readonly Violation[];
  /** What to draw: a line between rows, or a highlight on the row. */
  readonly indicator: 'line-before' | 'line-after' | 'highlight' | 'forbidden';
  /** True when the operation destroys an existing edge — renderers should style it distinctly. */
  readonly destructive: boolean;
}

/**
 * Resolve a gesture into a validated drop target.
 *
 * Call this on every drag-over. It is cheap (one cycle check) and it is the single place the
 * add-vs-move decision is made.
 */
export function resolveDrop<P>(groups: Groups<P>, gesture: DragGesture): DropTarget {
  const { source, target, modifiers, position = 'inside' } = gesture;

  const child = source.nodeId;
  const sourceParent = parentOfRow(source);

  // Reorder: dropping between two rows that share the target's parent.
  if (position !== 'inside') {
    const parent = parentOfRow(target);
    if (parent && sourceParent === parent) {
      return {
        operation: { type: 'reorder', child, parent, [position === 'before' ? 'after' : 'before']: target.nodeId } as DropOperation,
        valid: true,
        violations: [],
        indicator: position === 'before' ? 'line-before' : 'line-after',
        destructive: false,
      };
    }
  }

  const parent = position === 'inside' ? target.nodeId : parentOfRow(target);
  if (!parent) {
    return {
      operation: null,
      valid: false,
      reason: 'Nothing to drop into here.',
      violations: [],
      indicator: 'forbidden',
      destructive: false,
    };
  }

  if (child === parent) {
    return {
      operation: null,
      valid: false,
      reason: 'A group cannot contain itself.',
      violations: [],
      indicator: 'forbidden',
      destructive: false,
    };
  }

  const violations = canAddTo(groups.space, child, parent);
  if (violations.length) {
    return {
      operation: null,
      valid: false,
      reason: explain(groups, violations),
      violations,
      indicator: 'forbidden',
      destructive: false,
    };
  }

  // ⌥ = MOVE. Only meaningful when we know which parent to remove from.
  const wantsMove = Boolean(modifiers?.alt) && Boolean(sourceParent);

  if (wantsMove && sourceParent) {
    return {
      operation: { type: 'move', child, from: sourceParent, to: parent },
      valid: true,
      violations: [],
      indicator: 'highlight',
      destructive: true,
    };
  }

  return {
    operation: { type: 'add', child, parent },
    valid: true,
    violations: [],
    indicator: 'highlight',
    destructive: false,
  };
}

/** Commit a resolved drop. A no-op for an invalid target. */
export function applyDrop<P>(groups: Groups<P>, target: DropTarget): boolean {
  const op = target.operation;
  if (!op || !target.valid) return false;

  switch (op.type) {
    case 'add':
      return groups.add(op.child, op.parent).ok;
    case 'move':
      return groups.move(op.child, op.from, op.to).ok;
    case 'reorder':
      // Reordering is an edge update; the ranks come from the caller's fractional index.
      return true;
  }
}

/** The parent a row is being viewed under — the second-to-last element of its path. */
function parentOfRow(row: PathNode): NodeId | undefined {
  return row.path.length >= 2 ? row.path[row.path.length - 2] : undefined;
}

/**
 * Turn violations into a sentence.
 *
 * For a cycle, we name the offending route. Without that sentence, correct cycle prevention looks
 * exactly like a broken drop target.
 */
function explain<P>(groups: Groups<P>, violations: readonly Violation[]): string {
  const v = violations[0]!;
  if (v.code === 'cycle' && v.path?.length) {
    const labels = v.path.map((id) => groups.space.nodes.get(id)?.label ?? id);
    return `That would create a loop: ${labels.join(' → ')}.`;
  }
  return v.message;
}

/**
 * The two-verb menu, for when you have room for it. Gmail's answer, and the least surprising one.
 *
 * A renderer showing a context menu on an item should offer these rather than relying on a modifier
 * key the user has to know about.
 */
export interface MembershipAction {
  readonly verb: 'add' | 'move' | 'remove';
  readonly label: string;
  readonly destructive: boolean;
}

export const MEMBERSHIP_ACTIONS: readonly MembershipAction[] = [
  { verb: 'add', label: 'Add to group…', destructive: false },
  { verb: 'move', label: 'Move to group…', destructive: true },
  { verb: 'remove', label: 'Remove from this group', destructive: true },
];
