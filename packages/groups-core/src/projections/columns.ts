/**
 * Miller columns — the projection that survives polyhierarchy best.
 *
 * A column browser (NeXTSTEP's, and every macOS Finder column view since) shows one level per
 * column, each column listing the children of the item selected in the column to its left. It looks
 * like a lesser tree view. It isn't: **for a DAG it is strictly better, and for a reason that is
 * structural rather than aesthetic.**
 *
 * A column stack *is* a path. The user selects `Archive`, then `Research`, then `Reading` — and the
 * sequence of selections is, literally, the route they took. There is never any ambiguity about
 * "which of this node's several parents am I looking at it under", because the answer is on screen,
 * to the left. The tree view has to *invent* an answer to that question (and then key its expansion
 * state correctly, and then explain why a node opened in two places at once); the column browser
 * never asks it.
 *
 * Mark Miller himself generalized the technique to directed graphs, which is a decent hint. And the
 * research is blunt about the corollary: the tree view survives polyhierarchy *least* well and costs
 * the most to get right — so it should not be the default projection.
 *
 * @see `docs/research/_reconciliation.md` — §4, D12.
 */

import type { GroupSpace, NodeId } from './../model.js';
import { edgesOf } from './../space.js';
import { compareOrder } from './../order.js';
import { pathKeyOf, type PathNode } from './tree.js';

/** One column: the children of the node selected in the previous column. */
export interface Column {
  /** The node whose children this column lists. `undefined` for the root column. */
  readonly parent?: NodeId;
  readonly parentLabel?: string;
  /** The route to this column — the selections that produced it. */
  readonly path: readonly NodeId[];
  readonly rows: readonly PathNode[];
  /** Which row in this column is selected (i.e. produced the next column). */
  readonly selected?: NodeId;
}

export interface ColumnsOptions {
  /**
   * The user's selection trail, root-first. Each entry opens the next column.
   *
   * This is the whole state of a column browser — one array. Compare with a tree view, which needs
   * a `Set<pathKey>` of expansions *and* a separate selection.
   */
  readonly trail?: readonly NodeId[];
  /** Where the first column starts. Defaults to the space's roots. */
  readonly roots?: readonly NodeId[];
  /** Include leaf items in the columns. Default `true`. */
  readonly includeItems?: boolean;
}

/**
 * Project the DAG into columns for the given selection trail.
 *
 * Returns `trail.length + 1` columns: one per selection, plus the next one to choose from.
 */
export function projectColumns<P>(space: GroupSpace<P>, options: ColumnsOptions = {}): Column[] {
  const { trail = [], includeItems = true } = options;
  const roots =
    options.roots ?? [...space.nodes.keys()].filter((id) => !space.inverse.has(id));

  const columns: Column[] = [];

  // Column 0: the roots.
  columns.push({
    path: [],
    rows: rowsFor(space, roots, [], includeItems),
    ...(trail[0] ? { selected: trail[0] } : {}),
  });

  // One column per selection.
  for (let i = 0; i < trail.length; i++) {
    const parent = trail[i]!;
    const path = trail.slice(0, i + 1);
    const children = edgesOf(space, parent)
      .filter((e) => space.profile.edgeKinds[e.kind]?.transitive)
      .map((e) => e.child);

    if (!children.length) break; // a leaf — no further column

    columns.push({
      parent,
      parentLabel: space.nodes.get(parent)?.label ?? parent,
      path,
      rows: rowsFor(space, children, path, includeItems),
      ...(trail[i + 1] ? { selected: trail[i + 1] } : {}),
    });
  }

  return columns;
}

function rowsFor<P>(
  space: GroupSpace<P>,
  ids: readonly NodeId[],
  parentPath: readonly NodeId[],
  includeItems: boolean,
): PathNode[] {
  const rows: PathNode[] = [];
  for (const id of ids) {
    const childCount = space.forward.get(id)?.size ?? 0;
    if (!includeItems && childCount === 0) continue;
    const path = [...parentPath, id];
    const parentCount = space.inverse.get(id)?.size ?? 0;
    const edge = parentPath.length
      ? edgesOf(space, parentPath[parentPath.length - 1]!).find((e) => e.child === id)
      : undefined;

    rows.push({
      nodeId: id,
      pathKey: pathKeyOf(path),
      path,
      depth: path.length - 1,
      label: edge?.label ?? space.nodes.get(id)?.label ?? id,
      hasChildren: childCount > 0,
      childCount,
      otherParentCount: Math.max(0, parentCount - (parentPath.length ? 1 : 0)),
      isRecursive: parentPath.includes(id),
      ...(edge ? { edge } : {}),
    });
  }

  return rows.sort((a, b) => {
    const byOrder = compareOrder(a.edge?.order, b.edge?.order);
    if (byOrder !== 0) return byOrder;
    if (a.hasChildren !== b.hasChildren) return a.hasChildren ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}
