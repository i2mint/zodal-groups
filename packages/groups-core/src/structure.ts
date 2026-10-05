/**
 * Structural validity of a node and an edge — the one definition shared by the write path
 * (`applyDelta`) and the read path (`parseSnapshot`).
 *
 * The invariant this module exists for: **anything `applyDelta` accepts, `parseSnapshot` loads.**
 * When the two disagreed, a write could persist a value the next load refused, and a file-backed
 * store was bricked by its own output (a `maxPerItem: 1.5` family rule was the case that found it).
 */

import type { FamilyRule } from './model.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A valid per-family cardinality rule: `{ maxPerItem }`, an integer ≥ 1. */
export function isFamilyRule(value: unknown): value is FamilyRule {
  return isObject(value) && Number.isInteger(value.maxPerItem) && (value.maxPerItem as number) >= 1;
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';
const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * What is structurally wrong with a node, as `"field: problem"`, or `undefined` if nothing is.
 * A field set to `undefined` counts as absent (an upsert uses it to clear the field).
 */
export function nodeProblem(node: unknown): string | undefined {
  if (!isObject(node)) return 'expected an object';
  if (!nonEmpty(node.id)) return `id: expected a non-empty string, got ${JSON.stringify(node.id)}`;
  if (!optionalString(node.label)) return `label: expected a string, got ${JSON.stringify(node.label)}`;
  if (node.family !== undefined && !isFamilyRule(node.family)) {
    return `family: expected { maxPerItem: an integer ≥ 1 }, got ${JSON.stringify(node.family)}`;
  }
  return undefined;
}

/** What is structurally wrong with an edge, as `"field: problem"`, or `undefined` if nothing is. */
export function edgeProblem(edge: unknown): string | undefined {
  if (!isObject(edge)) return 'expected an object';
  for (const key of ['id', 'parent', 'child', 'kind'] as const) {
    if (!nonEmpty(edge[key])) return `${key}: expected a non-empty string, got ${JSON.stringify(edge[key])}`;
  }
  if (!optionalString(edge.label)) return `label: expected a string, got ${JSON.stringify(edge.label)}`;
  if (!optionalString(edge.order)) return `order: expected a string, got ${JSON.stringify(edge.order)}`;
  if (edge.meta !== undefined && !isObject(edge.meta)) return `meta: expected an object, got ${JSON.stringify(edge.meta)}`;
  return undefined;
}

/**
 * Structural equality of two JSON-shaped values; a key whose value is `undefined` counts as absent.
 * Used to check that a tombstone still matches the live node.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i]));
  }
  const keys = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
