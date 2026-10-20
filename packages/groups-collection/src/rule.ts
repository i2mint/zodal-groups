/**
 * Smart-group rules (D36): a `FilterExpression` from `@zodal/core` over the item records, stored on
 * the group's node. Checked before it is stored — `@zodal/store` evaluates an unknown operator as
 * "matches", so a typo would silently select the whole collection — and evaluated by asking the
 * provider when it can filter on everything the rule names, locally otherwise.
 */

import type { FilterCondition, FilterExpression, FilterOperator } from '@zodal/core';
import { filterToFunction, type DataProvider } from '@zodal/store';

/** The operators of `@zodal/core`'s `FilterOperator`. */
export const FILTER_OPERATORS: readonly FilterOperator[] = Object.freeze([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith',
  'in', 'notIn', 'arrayContains', 'arrayContainsAny', 'isNull', 'isNotNull',
] satisfies FilterOperator[]);

const LIST_OPERATORS: ReadonlySet<string> = new Set(['in', 'notIn', 'arrayContainsAny']);
const UNARY_OPERATORS: ReadonlySet<string> = new Set(['isNull', 'isNotNull']);

/** What stops `value` from being a well-formed `FilterExpression`, as `"path: problem"`, or `undefined`. */
export function filterProblem(value: unknown, path = 'rule'): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: expected a filter expression (an object)`;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  for (const k of ['and', 'or'] as const) {
    if (!(k in v)) continue;
    if (keys.length !== 1) return `${path}: '${k}' takes no sibling keys, got ${keys.join(', ')}`;
    const parts = v[k];
    if (!Array.isArray(parts) || !parts.length) return `${path}.${k}: expected a non-empty array`;
    for (const [i, part] of parts.entries()) {
      const problem = filterProblem(part, `${path}.${k}[${i}]`);
      if (problem) return problem;
    }
    return undefined;
  }
  if ('not' in v) return keys.length !== 1 ? `${path}: 'not' takes no sibling keys, got ${keys.join(', ')}` : filterProblem(v.not, `${path}.not`);
  if (typeof v.field !== 'string' || !v.field) return `${path}.field: expected a non-empty string`;
  if (!FILTER_OPERATORS.includes(v.operator as FilterOperator)) {
    return `${path}.operator: expected one of ${FILTER_OPERATORS.join(', ')}, got ${JSON.stringify(v.operator)}`;
  }
  if (LIST_OPERATORS.has(v.operator as string) && !Array.isArray(v.value)) return `${path}.value: '${v.operator}' expects an array`;
  if (!UNARY_OPERATORS.has(v.operator as string) && v.value === undefined) return `${path}.value: '${v.operator}' expects a value`;
  return undefined;
}

/** The leaf conditions of a filter expression. */
function conditionsOf(filter: FilterExpression): FilterCondition[] {
  if ('and' in filter) return filter.and.flatMap(conditionsOf);
  if ('or' in filter) return filter.or.flatMap(conditionsOf);
  if ('not' in filter) return conditionsOf(filter.not);
  return [filter];
}

/**
 * Can `provider` evaluate `filter` itself? Yes unless its capabilities say it cannot filter on a
 * field the rule names, or with an operator the rule uses (a provider without `getCapabilities`
 * is taken at its `getList` contract).
 */
export function canPushFilter(provider: DataProvider<any>, filter: FilterExpression): boolean {
  const caps = provider.getCapabilities?.();
  if (!caps) return true;
  return conditionsOf(filter).every(
    (c) =>
      (caps.serverFilter === true || (Array.isArray(caps.serverFilter) && caps.serverFilter.includes(c.field))) &&
      (!caps.filterOperators?.[c.field] || caps.filterOperators[c.field]!.includes(c.operator)),
  );
}

/** Evaluate `filter` on records already read, as `@zodal/store` does. */
export const localFilter = <T extends Record<string, unknown>>(records: readonly T[], filter: FilterExpression): T[] =>
  records.filter(filterToFunction<T>(filter));
