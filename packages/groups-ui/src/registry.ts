/**
 * The renderer registry — capability-ranked, open-closed.
 *
 * Identical in spirit to `@zodal/ui`'s: a renderer registers a `tester` that scores a
 * `(surface, profile)` context, and the highest score wins. Adding a renderer never means editing a
 * switch statement.
 *
 * The reason it is keyed on **profile as well as surface** is specific to this domain: the right
 * default view genuinely depends on the constraints. A `filesystem` space should default to a tree
 * (the metaphor everyone knows). A `polyhierarchy` space probably should not — the research is blunt
 * that the tree view survives polyhierarchy *least* well and costs the most to get right, while
 * Miller columns, drill-down, and faceted browsing survive it natively (a column stack *is* a path,
 * so it never has to guess which of several parents you are viewing a node under). A registry lets
 * that judgement be expressed as a score rather than hard-coded.
 */

import { isFlat, isSingleHomed, type GroupProfile } from '@zodal/groups-core';

/** The UI surfaces a renderer package may implement. */
export type Surface =
  | 'tree'
  | 'columns'
  | 'breadcrumbs'
  | 'facets'
  | 'tagInput'
  | 'treeSelect'
  | 'otherLocations'
  | 'icicle';

export interface RendererContext {
  readonly surface: Surface;
  readonly profile: GroupProfile;
  readonly [key: string]: unknown;
}

/** Returns a score. `0` means "I don't handle this". Highest wins. */
export type RendererTester = (context: RendererContext) => number;

export interface RendererEntry<TComponent> {
  readonly tester: RendererTester;
  readonly renderer: TComponent;
  readonly name?: string;
}

/** Priority bands. Use these, not arbitrary numbers — it keeps third-party renderers composable. */
export const PRIORITY = {
  FALLBACK: 1,
  DEFAULT: 10,
  LIBRARY: 50,
  APP: 100,
  OVERRIDE: 200,
} as const;

export interface RendererRegistry<TComponent> {
  readonly entries: ReadonlyArray<RendererEntry<TComponent>>;
  register(entry: RendererEntry<TComponent>): void;
  resolve(context: RendererContext): TComponent | null;
  /** Every candidate and its score — for debugging "why did I get that renderer?". */
  explain(context: RendererContext): Array<{ name?: string; score: number }>;
}

export function createRendererRegistry<TComponent>(
  initial: ReadonlyArray<RendererEntry<TComponent>> = [],
): RendererRegistry<TComponent> {
  const entries: RendererEntry<TComponent>[] = [...initial];

  return {
    get entries() {
      return entries;
    },
    register(entry) {
      entries.push(entry);
    },
    resolve(context) {
      let best: { score: number; renderer: TComponent } | null = null;
      for (const entry of entries) {
        const score = entry.tester(context);
        if (score > 0 && (!best || score > best.score)) best = { score, renderer: entry.renderer };
      }
      return best?.renderer ?? null;
    },
    explain(context) {
      return entries
        .map((e) => ({ ...(e.name ? { name: e.name } : {}), score: e.tester(context) }))
        .sort((a, b) => b.score - a.score);
    },
  };
}

// ── composable testers ──────────────────────────────────────────────────────

export const surfaceIs =
  (...surfaces: Surface[]): RendererTester =>
  (ctx) =>
    surfaces.includes(ctx.surface) ? PRIORITY.LIBRARY : 0;

export const profileIs =
  (...names: string[]): RendererTester =>
  (ctx) =>
    names.includes(ctx.profile.name) ? PRIORITY.LIBRARY : 0;

/**
 * True when the space can actually put one thing in two places.
 *
 * A renderer that cannot honestly show a node in two locations (a naive tree that keys expansion by
 * node id, say) should score `0` here rather than render a lie.
 */
export const isPolyhierarchical: RendererTester = (ctx) =>
  !isSingleHomed(ctx.profile) || !isFlat(ctx.profile) ? PRIORITY.LIBRARY : 0;

export const and =
  (...testers: RendererTester[]): RendererTester =>
  (ctx) => {
    let total = 0;
    for (const t of testers) {
      const score = t(ctx);
      if (score === 0) return 0;
      total = Math.max(total, score);
    }
    return total;
  };

export const or =
  (...testers: RendererTester[]): RendererTester =>
  (ctx) =>
    Math.max(...testers.map((t) => t(ctx)), 0);
