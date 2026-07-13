/**
 * A vanilla breadcrumb trail — with the multi-path affordance polyhierarchy requires.
 *
 * In a tree a breadcrumb is trivial, because there is exactly one route to any node. Under
 * polyhierarchy there may be several, and pretending otherwise is how you teleport a user somewhere
 * they have never been. So this renderer does two things a normal breadcrumb does not:
 *
 * 1. It honours **navigational context** — the route the user actually walked (`arrivedVia`) —
 *    rather than recomputing a "canonical" path they may never have seen.
 * 2. When other routes exist, it says so, and offers them. A silent choice among several paths is
 *    the bug; an explicit "3 other paths" chip is the fix.
 */

import type { Groups, NodeId } from '@zodal/groups-core';
import { toBreadcrumbs } from '@zodal/groups-ui';

export interface BreadcrumbsRenderer {
  show(node: NodeId, arrivedVia?: readonly NodeId[]): void;
  destroy(): void;
  readonly element: HTMLElement;
}

export function renderBreadcrumbs<P>(
  container: HTMLElement,
  groups: Groups<P>,
  options: {
    readonly onNavigate?: (nodeId: NodeId, path: readonly NodeId[]) => void;
    readonly onShowOtherPaths?: (paths: ReturnType<Groups<P>['paths']>) => void;
  } = {},
): BreadcrumbsRenderer {
  const nav = document.createElement('nav');
  nav.className = 'zg-breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');
  container.appendChild(nav);

  const show = (node: NodeId, arrivedVia?: readonly NodeId[]): void => {
    const view = toBreadcrumbs(groups, node, arrivedVia ? { arrivedVia } : {});
    if (!view) {
      nav.replaceChildren();
      return;
    }

    const ol = document.createElement('ol');
    for (const [i, crumb] of view.crumbs.entries()) {
      const li = document.createElement('li');

      if (crumb.isLast) {
        li.textContent = crumb.label;
        li.setAttribute('aria-current', 'page');
      } else {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'zg-crumb';
        a.textContent = crumb.label;
        a.addEventListener('click', () =>
          options.onNavigate?.(crumb.nodeId, view.crumbs.slice(0, i + 1).map((c) => c.nodeId)),
        );
        li.appendChild(a);
      }
      ol.appendChild(li);
    }
    nav.replaceChildren(ol);

    // The polyhierarchy-specific part: this is one route among several. Say so.
    if (view.otherPathCount > 0) {
      const other = document.createElement('button');
      other.type = 'button';
      other.className = 'zg-other-paths';
      other.textContent = `+${view.otherPathCount} other path${view.otherPathCount === 1 ? '' : 's'}`;
      other.title = 'This is reachable by more than one route';
      other.addEventListener('click', () => options.onShowOtherPaths?.(groups.paths(node)));
      nav.appendChild(other);
    }
  };

  return {
    show,
    element: nav,
    destroy: () => nav.remove(),
  };
}
