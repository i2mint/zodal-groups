/**
 * Paths, breadcrumbs, and "what other groups is this in?".
 *
 * In a tree there is exactly one path to a node, so a path can serve as an identifier — which is
 * why filesystems get away with `/usr/local/bin` as a name. **Under polyhierarchy that stops being
 * true.** A path becomes a *route*, not an identity, and everything that assumed otherwise needs a
 * decision:
 *
 * - a **breadcrumb** must choose which of several routes to show;
 * - a **URL** or deep link needs a stable one, so it needs an explicit `primaryPath`;
 * - and anything that enumerates *all* routes needs a hard cap, because the number of distinct
 *   root-paths in a DAG is exponential in its depth (a chain of diamonds gives 2^d).
 *
 * MeSH is the cautionary tale here: because its parent edges live between *tree-number positions*
 * rather than between concepts, its descriptor-level shortcut disagrees with the tree walk — and
 * their own documentation warns you about it. Pick one representation and derive the other.
 *
 * The functions in this module are also the home of the affordance that only exists once you leave
 * trees behind: `otherLocations()` — "this item is also in 3 other groups". It is meaningless in a
 * filesystem and essential here. Are.na's *"This channel appears in"* is the reference
 * implementation.
 *
 * @see `docs/research/_reconciliation.md` — §2.5, D15.
 */

import type { Edge, GroupSpace, NodeId } from './../model.js';
import { edgesInto } from './../space.js';
import { pathKeyOf } from './tree.js';

/** One route to a node, from a root. */
export interface NodePath {
  /** Root-first, ending in the node itself. */
  readonly path: readonly NodeId[];
  readonly pathKey: string;
  readonly labels: readonly string[];
  readonly depth: number;
}

export interface PathOptions {
  /** Stop after this many distinct paths. Defaults to 32 — the exponential guard. */
  readonly limit?: number;
  /** Ignore paths longer than this. */
  readonly maxDepth?: number;
}

/**
 * Every route from a root to `node`, de-duplicated and capped.
 *
 * The cap is not optional. Enumerating all paths in a DAG is exponential, and an uncapped call on
 * real data will hang. If you hit the cap, `primaryPath` is what you actually wanted.
 */
export function allPaths<P>(space: GroupSpace<P>, node: NodeId, options: PathOptions = {}): NodePath[] {
  const { limit = 32, maxDepth = 64 } = options;
  const out: NodePath[] = [];

  const walk = (current: NodeId, suffix: NodeId[], seen: ReadonlySet<NodeId>): void => {
    if (out.length >= limit) return;
    if (suffix.length > maxDepth) return;

    const incoming = edgesInto(space, current).filter(
      (e) => space.profile.edgeKinds[e.kind]?.transitive && !seen.has(e.parent),
    );

    if (incoming.length === 0) {
      out.push(toNodePath(space, [current, ...suffix]));
      return;
    }
    for (const edge of incoming) {
      if (out.length >= limit) return;
      walk(edge.parent, [current, ...suffix], new Set([...seen, current]));
    }
  };

  walk(node, [], new Set());
  return out;
}

function toNodePath<P>(space: GroupSpace<P>, path: readonly NodeId[]): NodePath {
  return {
    path,
    pathKey: pathKeyOf(path),
    labels: path.map((id) => space.nodes.get(id)?.label ?? id),
    depth: path.length - 1,
  };
}

/**
 * The one route to show in a breadcrumb or put in a URL.
 *
 * Strategies:
 * - `'shortest'` (default) — the shallowest route. Stable, cheap, and usually the one a user would
 *   describe out loud.
 * - `'first'` — the first edge added. Preserves authoring intent.
 * - a `(paths) => NodePath` function — bring your own rule (e.g. "prefer the route through the
 *   user's pinned folder").
 *
 * There is deliberately no `parentOf()` returning a single parent anywhere in this library. An
 * implicit "primary parent" is the `..` ambiguity Unix refused to ship, and it is a lie that leaks
 * into every breadcrumb. If you want one route, you have to *ask* for one — which makes the choice,
 * and its arbitrariness, visible at the call site.
 */
export function primaryPath<P>(
  space: GroupSpace<P>,
  node: NodeId,
  strategy: 'shortest' | 'first' | ((paths: readonly NodePath[]) => NodePath) = 'shortest',
): NodePath | undefined {
  const paths = allPaths(space, node);
  if (!paths.length) return undefined;
  if (typeof strategy === 'function') return strategy(paths);
  if (strategy === 'first') return paths[0];
  return paths.reduce((best, p) => (p.depth < best.depth ? p : best), paths[0]!);
}

/**
 * Breadcrumbs for a node, in the context of how the user actually got there.
 *
 * `arrivedVia` is the trail the user walked — pass the `path` of the `PathNode` they clicked. This
 * is *navigational context*, and honouring it is the difference between a breadcrumb that orients
 * the user and one that teleports them somewhere they've never been. When you have it, use it; the
 * `primaryPath` fallback is for cold entry (a deep link, a search result).
 */
export function breadcrumbs<P>(
  space: GroupSpace<P>,
  node: NodeId,
  options: { readonly arrivedVia?: readonly NodeId[] } = {},
): NodePath | undefined {
  if (options.arrivedVia?.length) {
    const trail = options.arrivedVia;
    const path = trail[trail.length - 1] === node ? trail : [...trail, node];
    return toNodePath(space, path);
  }
  return primaryPath(space, node);
}

/** A group a node belongs to, other than the one you're looking at it in. */
export interface OtherLocation {
  readonly group: NodeId;
  readonly label: string;
  readonly edge: Edge;
  /** The route to that group, for a "reveal" action. */
  readonly path?: NodePath;
}

/**
 * "What *other* groups is this item in?"
 *
 * The affordance that has no meaning in a tree and is indispensable here. Surface it wherever a
 * single item is shown — as label chips (Gmail), a "This channel appears in" panel (Are.na), or a
 * "Reveal in…" menu (DEVONthink). It is also the accessible answer to multi-parenthood: since ARIA
 * cannot express two parents structurally, a keyboard command that opens *this list* — a flat,
 * linear, fully-navigable structure — is strictly better than trying to force the tree to say it.
 *
 * @param excluding the group you're currently viewing the item in, if any.
 */
export function otherLocations<P>(
  space: GroupSpace<P>,
  node: NodeId,
  excluding?: NodeId,
): OtherLocation[] {
  return edgesInto(space, node)
    .filter((e) => e.parent !== excluding)
    .map((edge) => ({
      group: edge.parent,
      label: space.nodes.get(edge.parent)?.label ?? edge.parent,
      edge,
      ...(() => {
        const path = primaryPath(space, edge.parent);
        return path ? { path } : {};
      })(),
    }));
}
