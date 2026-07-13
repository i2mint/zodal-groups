/**
 * The add-vs-move intent model — the most dangerous interaction in the library.
 */

import { describe, expect, it } from 'vitest';
import { defineGroups, nodeId } from '@zodal/groups-core';
import { resolveDrop, applyDrop, toTreeRows } from '../src/index.js';

/** `reading` under BOTH `research` and `leisure`; `paper` inside `reading`. */
const build = () => {
  const g = defineGroups({ profile: 'polyhierarchy' });
  g.add('paper', 'reading');
  g.add('reading', 'research');
  g.add('reading', 'leisure');
  g.add('note', 'inbox');
  return g;
};

const rowFor = (g: ReturnType<typeof build>, nodeIdStr: string, underPath?: string) => {
  const rows = toTreeRows(g, { expandAll: true });
  return rows.find(
    (r) => r.nodeId === nodeIdStr && (!underPath || r.source.path.includes(nodeId(underPath))),
  )!;
};

describe('drag defaults to ADD, not MOVE', () => {
  it('a plain drag ADDS a parent — nothing is destroyed', () => {
    const g = build();
    const drop = resolveDrop(g, {
      source: rowFor(g, 'note').source,
      target: rowFor(g, 'research').source,
    });

    expect(drop.valid).toBe(true);
    expect(drop.operation?.type).toBe('add');
    expect(drop.destructive).toBe(false);

    applyDrop(g, drop);
    // Still in `inbox`, AND now in `research`. The safe outcome.
    expect(g.parents('note').sort()).toEqual(['inbox', 'research']);
  });

  it('⌥ (alt) turns it into a MOVE — and is flagged destructive', () => {
    const g = build();
    const drop = resolveDrop(g, {
      source: rowFor(g, 'note').source,
      target: rowFor(g, 'research').source,
      modifiers: { alt: true },
    });

    expect(drop.operation?.type).toBe('move');
    expect(drop.destructive).toBe(true); // renderers MUST style this differently

    applyDrop(g, drop);
    expect(g.parents('note')).toEqual(['research']); // `inbox` edge destroyed
  });

  it('falls back to ADD when there is no source group to move out of', () => {
    // Dragging from a search result or a flat list: MOVE is literally undefined.
    const g = build();
    const root = toTreeRows(g, { expandAll: true }).find((r) => r.depth === 0)!;

    const drop = resolveDrop(g, {
      source: root.source, // a root — no parent
      target: rowFor(g, 'inbox').source,
      modifiers: { alt: true }, // even WITH the modifier
    });

    expect(drop.operation?.type).toBe('add');
    expect(drop.destructive).toBe(false);
  });
});

describe('an invalid drop explains itself', () => {
  it('names the offending route when the drop would create a cycle', () => {
    const g = build();
    const drop = resolveDrop(g, {
      source: rowFor(g, 'research').source, // dragging an ancestor...
      target: rowFor(g, 'paper', 'research').source, // ...into its own descendant
    });

    expect(drop.valid).toBe(false);
    expect(drop.indicator).toBe('forbidden');
    // Without this sentence, correct cycle prevention is indistinguishable from a bug — the loop
    // may close through a branch that is not even on screen.
    expect(drop.reason).toContain('loop');
    expect(drop.reason).toContain('→');
  });

  it('refuses a second parent under a single-homed profile, and says why', () => {
    const g = defineGroups({ profile: 'filesystem' });
    g.add('report', 'documents');
    g.add('x', 'archive');

    const rows = toTreeRows(g, { expandAll: true });
    const drop = resolveDrop(g, {
      source: rows.find((r) => r.nodeId === 'report')!.source,
      target: rows.find((r) => r.nodeId === 'archive')!.source,
    });

    expect(drop.valid).toBe(false);
    expect(drop.violations[0]!.code).toBe('maxParentsPerItem');
    expect(drop.reason).toBeTruthy();
  });

  it('never produces an operation for an invalid drop', () => {
    const g = build();
    const drop = resolveDrop(g, {
      source: rowFor(g, 'reading', 'research').source,
      target: rowFor(g, 'reading', 'research').source,
    });
    expect(drop.operation).toBeNull();
    expect(applyDrop(g, drop)).toBe(false);
  });
});
