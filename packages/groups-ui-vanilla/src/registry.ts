/**
 * The vanilla renderer registry.
 *
 * Note the scores: for a `filesystem` profile the tree wins, because that is the metaphor every user
 * already has. For anything genuinely polyhierarchical, **Miller columns win** — a column stack is a
 * path, so it never has to guess which of several parents you are viewing a node under, while the
 * tree has to invent an answer. That judgement is expressed here as a score rather than hard-coded
 * in a component, which is the point of having a registry at all.
 */

import {
  createRendererRegistry,
  PRIORITY,
  type RendererRegistry,
  type Surface,
} from '@zodal/groups-ui';
import { isSingleHomed } from '@zodal/groups-core';
import { renderTree } from './tree.js';
import { renderColumns } from './columns.js';
import { renderBreadcrumbs } from './breadcrumbs.js';
import { renderFacets } from './facets.js';
import { renderTagInput } from './tag-input.js';

/** Every vanilla renderer is `(container, groups, options) => something with .destroy()`. */
export type VanillaRenderer = (container: HTMLElement, groups: never, options?: never) => { destroy(): void };

export function createVanillaRegistry(): RendererRegistry<VanillaRenderer> {
  const registry = createRendererRegistry<VanillaRenderer>();

  registry.register({
    name: 'vanilla:tree',
    tester: (ctx) => {
      if (ctx.surface !== 'tree') return 0;
      // The tree is the right default when an item lives in one place; less so otherwise.
      return isSingleHomed(ctx.profile) ? PRIORITY.LIBRARY + 5 : PRIORITY.LIBRARY;
    },
    renderer: renderTree as unknown as VanillaRenderer,
  });

  registry.register({
    name: 'vanilla:columns',
    tester: (ctx) => {
      if (ctx.surface !== 'columns') return 0;
      // Miller columns handle multi-parenthood natively: the trail IS the disambiguation.
      return isSingleHomed(ctx.profile) ? PRIORITY.LIBRARY : PRIORITY.LIBRARY + 10;
    },
    renderer: renderColumns as unknown as VanillaRenderer,
  });

  const simple: Array<[Surface, string, unknown]> = [
    ['breadcrumbs', 'vanilla:breadcrumbs', renderBreadcrumbs],
    ['facets', 'vanilla:facets', renderFacets],
    ['tagInput', 'vanilla:tag-input', renderTagInput],
  ];

  for (const [surface, name, renderer] of simple) {
    registry.register({
      name,
      tester: (ctx) => (ctx.surface === surface ? PRIORITY.LIBRARY : 0),
      renderer: renderer as VanillaRenderer,
    });
  }

  return registry;
}
