/**
 * The undo history's way out (M-3): a refused undo keeps its entry — skipping it would make the
 * next undo apply to the wrong state — and the caller can ask why (`undoViolations`) and drop it
 * (`discardUndo`).
 */

import { describe, expect, it } from 'vitest';
import { defineGroups } from '../src/index.js';

describe('undoViolations / discardUndo', () => {
  it('a blocked undo says why, and can be discarded', () => {
    const g = defineGroups();
    g.add('a', 'g'); // creates g
    g.add('b', 'g');
    expect(g.undoDepth).toBe(2);
    expect(g.undoViolations()).toEqual([]);

    // Dropping the newer entry leaves an older one whose inverse would delete g, which b still uses.
    expect(g.discardUndo()).toBeDefined();
    expect(g.undoDepth).toBe(1);
    expect(g.undoViolations().map((v) => v.code)).toEqual(['danglingEdge']);
    expect(g.undo()).toBe(false);
    expect(g.undoDepth).toBe(1); // kept: no silent skip

    expect(g.discardUndo()).toBeDefined(); // the way out
    expect(g.undoDepth).toBe(0);
    expect(g.undo()).toBe(false);
    expect(g.discardUndo()).toBeUndefined();
    expect(g.children('g').sort()).toEqual(['a', 'b']); // nothing was undone along the way
  });
});
