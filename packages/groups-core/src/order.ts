/**
 * Ordering within a group — fractional indexing.
 *
 * An item in three groups needs three ranks, so order is a property of the **membership edge**, not
 * of the item. (This is an independent argument for reifying the edge: with a bare
 * `Set<[item, group]>` there is nowhere to put the rank.)
 *
 * We use fractional indexing: a rank is a sortable *string*, and inserting between two neighbours
 * mints a new string strictly between them. Nothing else moves. The alternative — integer positions
 * — requires rewriting every sibling's rank on each reorder, which is exactly the write
 * amplification we designed the rest of the library to avoid.
 *
 * Because a rank is just a string, plain lexicographic `sort` works on every backend with **zero new
 * capabilities**: no adapter needs a special "reorder" operation.
 *
 * ## The sharp edge
 *
 * Locale-aware comparison **silently corrupts** this ordering. `'a'.localeCompare('B')` is negative
 * under most locales but positive under a byte comparison, so a locale-aware sort will interleave
 * keys that were minted to be adjacent. Use `compareOrder` below (which compares by code unit), and
 * on Postgres declare the column `COLLATE "C"`. This bug is quiet — the list is *mostly* right —
 * which is what makes it worth a paragraph.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MIN = DIGITS[0]!;
const MAX = DIGITS[DIGITS.length - 1]!;

/**
 * Compare two ranks. Byte order, not locale order — see the module docstring.
 *
 * Absent ranks sort last, so unordered members fall to the bottom rather than jumping to the top.
 */
export function compareOrder(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Mint a rank strictly between `before` and `after`.
 *
 * Pass `undefined` for either end to append or prepend:
 *   `orderBetween(undefined, first)` → before everything
 *   `orderBetween(last, undefined)`  → after everything
 *   `orderBetween(a, b)`             → between them
 *
 * @throws if `before >= after` — a caller that passes an inverted pair has a bug upstream, and
 *   silently "fixing" it would produce a list that reorders itself unpredictably.
 */
export function orderBetween(before?: string, after?: string): string {
  if (before !== undefined && after !== undefined && before >= after) {
    throw new Error(`orderBetween: '${before}' is not before '${after}'.`);
  }

  const lo = before ?? '';
  const hi = after;

  let prefix = '';
  let i = 0;

  // Copy the common prefix.
  while (true) {
    const loDigit = i < lo.length ? lo[i]! : MIN;
    const hiDigit = hi !== undefined && i < hi.length ? hi[i]! : undefined;
    if (hiDigit !== undefined && loDigit === hiDigit) {
      prefix += loDigit;
      i += 1;
      continue;
    }
    break;
  }

  const loDigit = i < lo.length ? lo[i]! : MIN;
  const loIdx = DIGITS.indexOf(loDigit);
  const hiIdx = hi !== undefined && i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;

  if (hiIdx - loIdx > 1) {
    // There is room between them — pick the midpoint.
    const mid = Math.floor((loIdx + hiIdx) / 2);
    return prefix + DIGITS[mid]!;
  }

  // No room: keep `lo`'s digit and descend a level, appending to the remainder of `lo`.
  const rest = lo.slice(i + 1);
  return prefix + loDigit + orderBetween(rest === '' ? undefined : rest, undefined);
}

/** `n` evenly-spread ranks, for seeding a fresh list. */
export function initialOrders(n: number): string[] {
  const out: string[] = [];
  let last: string | undefined;
  for (let i = 0; i < n; i++) {
    last = orderBetween(last, undefined);
    out.push(last);
  }
  return out;
}
