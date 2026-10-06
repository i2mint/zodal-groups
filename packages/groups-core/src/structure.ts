/**
 * Structural validity of a node and an edge — the one definition shared by the write path
 * (`applyDelta`) and the read path (`parseSnapshot`).
 *
 * The invariant this module exists for: **anything `applyDelta` accepts, `parseSnapshot` loads.**
 * When the two disagreed, a write could persist a value the next load refused, and a file-backed
 * store was bricked by its own output (a `maxPerItem: 1.5` family rule was the case that found it).
 */

import type { FamilyRule } from './model.js';

/** JSON.stringify that cannot throw (a BigInt or a cycle would), for error messages. */
export const safe = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A valid per-family cardinality rule: `{ maxPerItem }`, an integer ≥ 1. */
export function isFamilyRule(value: unknown): value is FamilyRule {
  return isObject(value) && Number.isInteger(value.maxPerItem) && (value.maxPerItem as number) >= 1;
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';

/**
 * What stops `value` from being plain JSON data — the only thing a store can persist and read back
 * unchanged — as `"path: problem"`, or `undefined`. Refused: BigInt (JSON.stringify throws, so a
 * file store failed on write), functions, symbols, NaN/±Infinity (become `null`), class instances
 * such as Date or Map (become a string or `{}`), and cycles. A key set to `undefined` is absent.
 */
export function jsonProblem(value: unknown, path = 'value', seen: Set<object> = new Set()): string | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'undefined':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : `${path}: ${String(value)} is not a JSON number`;
    case 'bigint':
      return `${path}: a BigInt is not JSON (store it as a string)`;
    case 'function':
    case 'symbol':
      return `${path}: a ${typeof value} is not JSON data`;
  }
  if (value === null) return undefined;
  const object = value as object;
  if (seen.has(object)) return `${path}: a cycle — JSON cannot hold it`;
  const proto = Object.getPrototypeOf(object);
  if (!Array.isArray(object) && proto !== Object.prototype && proto !== null) {
    return `${path}: a ${proto?.constructor?.name ?? 'class'} instance is not plain JSON data (convert it first)`;
  }
  seen.add(object);
  const entries: [string, unknown][] = Array.isArray(object)
    ? object.map((v, i) => [`[${i}]`, v])
    : Object.entries(object).map(([k, v]) => [`.${k}`, v]);
  for (const [key, child] of entries) {
    if (Array.isArray(object) && child === undefined) return `${path}${key}: undefined in an array becomes null`;
    const problem = jsonProblem(child, `${path}${key}`, seen);
    if (problem) return problem;
  }
  seen.delete(object);
  return undefined;
}
const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * What is structurally wrong with a node, as `"field: problem"`, or `undefined` if nothing is.
 * A field set to `undefined` counts as absent (an upsert uses it to clear the field).
 */
export function nodeProblem(node: unknown): string | undefined {
  if (!isObject(node)) return 'expected an object';
  if (!nonEmpty(node.id)) return `id: expected a non-empty string, got ${safe(node.id)}`;
  if (!optionalString(node.label)) return `label: expected a string, got ${safe(node.label)}`;
  if (node.family !== undefined && !isFamilyRule(node.family)) {
    return `family: expected { maxPerItem: an integer ≥ 1 }, got ${safe(node.family)}`;
  }
  return jsonProblem(node.payload, 'payload');
}

/** What is structurally wrong with an edge, as `"field: problem"`, or `undefined` if nothing is. */
export function edgeProblem(edge: unknown): string | undefined {
  if (!isObject(edge)) return 'expected an object';
  for (const key of ['id', 'parent', 'child', 'kind'] as const) {
    if (!nonEmpty(edge[key])) return `${key}: expected a non-empty string, got ${safe(edge[key])}`;
  }
  if (!optionalString(edge.label)) return `label: expected a string, got ${safe(edge.label)}`;
  if (!optionalString(edge.order)) return `order: expected a string, got ${safe(edge.order)}`;
  if (edge.meta !== undefined && !isObject(edge.meta)) return `meta: expected an object, got ${safe(edge.meta)}`;
  return jsonProblem(edge.meta, 'meta');
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
