/**
 * `@zodal/groups-ui-vanilla` — zero-dependency renderers for zodal-groups.
 *
 * Plain DOM. No framework, no build step required, no peer dependencies beyond the two zodal
 * packages. It exists for three reasons: to prove the headless layer really is framework-free, to
 * give a reference implementation for anyone writing a renderer, and because a surprising number of
 * places that need a folder tree do not have React.
 *
 * ```ts
 * import { defineGroups } from '@zodal/groups-core';
 * import { renderTree, renderColumns } from '@zodal/groups-ui-vanilla';
 * import '@zodal/groups-ui-vanilla/styles.css';
 *
 * const groups = defineGroups({ profile: 'polyhierarchy' });
 * renderColumns(document.querySelector('#browser')!, groups);
 *
 * // Tag a selection: tri-state per group, staged until "Apply to N items".
 * renderTagMenu(document.querySelector('#labels')!, groups, { selection: ['a', 'b', 'c'] });
 * ```
 */

export { renderTree, type TreeRenderer, type TreeRendererOptions } from './tree.js';
export { renderColumns, type ColumnsRenderer, type ColumnsRendererOptions } from './columns.js';
export { renderBreadcrumbs, type BreadcrumbsRenderer } from './breadcrumbs.js';
export { renderFacets, type FacetsRenderer } from './facets.js';
export { renderTagInput, type TagInputRenderer } from './tag-input.js';
export { renderTagMenu, type TagMenuOptions, type TagMenuRenderer } from './tag-menu.js';
export { createVanillaRegistry } from './registry.js';
