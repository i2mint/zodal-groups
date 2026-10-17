/**
 * Media queries the renderers consult at render time — what kind of pointer is this?
 *
 * Read on every render (not once at import), so a tablet that gains a mouse, or a window moved
 * between screens, gets the right behaviour on the next render. Where there is no `matchMedia`
 * (jsdom, server rendering) the desktop answer is assumed, which keeps the renderers' behaviour
 * in tests the same as before the touch pass.
 */

/** A precise pointer (mouse, trackpad, stylus): where drag-and-drop is offered. */
export const FINE_POINTER = '(pointer: fine)';

/** Does `query` match? `fallback` when the environment cannot tell. */
export function mediaMatches(query: string, fallback = true): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : fallback;
  } catch {
    return fallback;
  }
}
