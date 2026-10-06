/**
 * Whatever `applyDelta` accepts must load back from a snapshot: a write may never brick a store.
 * One structural validator (`nodeProblem` / `edgeProblem` / `isFamilyRule`) serves both.
 */

import { describe, expect, it } from 'vitest';
import { applyDelta, createGroupSpace, isFamilyRule, nodeId, parseSnapshot, toSnapshot } from '../src/index.js';

const n = nodeId;

describe('family rules are validated on write (B2)', () => {
  for (const bad of [1.5, Number.NaN, -1, 0, Infinity, '1']) {
    it(`refuses maxPerItem: ${String(bad)}`, () => {
      const r = applyDelta(createGroupSpace(), { upsertNodes: [{ id: n('status'), family: { maxPerItem: bad as number } }] });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.violations[0]!.code).toBe('invalidFamilyRule');
        expect(r.violations[0]!.node).toBe('status');
      }
    });
  }

  it('refuses a family that is not an object', () => {
    const r = applyDelta(createGroupSpace(), { upsertNodes: [{ id: n('s'), family: 1 as never }] });
    expect(r.ok).toBe(false);
  });

  it('accepts integer caps ≥ 1, and clearing the rule', () => {
    const s = createGroupSpace({ nodes: [{ id: n('s'), family: { maxPerItem: 2 } }] });
    expect(applyDelta(s, { upsertNodes: [{ id: n('s'), family: undefined }] }).ok).toBe(true);
  });

  it('isFamilyRule is the one definition', () => {
    expect(isFamilyRule({ maxPerItem: 1 })).toBe(true);
    expect(isFamilyRule({ maxPerItem: 0 })).toBe(false);
    expect(isFamilyRule({ maxPerItem: 2.5 })).toBe(false);
    expect(isFamilyRule(null)).toBe(false);
    expect(() => parseSnapshot({ nodes: [{ id: 'a', family: { maxPerItem: 0 } }], edges: [] })).toThrow(/family/);
  });
});

describe('malformed nodes and edges are refused on write', () => {
  it('a non-string label', () => {
    const r = applyDelta(createGroupSpace(), { upsertNodes: [{ id: n('a'), label: 5 as never }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('malformed');
  });

  it('an edge with a non-string order or an empty id', () => {
    const bad = [
      { id: 'e' as never, parent: n('p'), child: n('c'), kind: 'contains', order: 3 as never },
      { id: '' as never, parent: n('p'), child: n('d'), kind: 'contains' },
    ];
    const r = applyDelta(createGroupSpace(), { added: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toEqual(['malformed', 'malformed']);
  });

  it('anything accepted round-trips through parseSnapshot', () => {
    const r = applyDelta(createGroupSpace(), {
      upsertNodes: [{ id: n('s'), label: 'S', family: { maxPerItem: 3 } }],
      added: [{ id: 'e1' as never, parent: n('s'), child: n('v'), kind: 'contains', order: 'a', meta: { by: 'x' } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(() => parseSnapshot(JSON.parse(JSON.stringify(toSnapshot(r.value))))).not.toThrow();
  });
});

describe('payload and meta must be plain JSON data (M-5)', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const bad: [string, unknown][] = [
    ['a BigInt', 10n],
    ['a nested BigInt', { a: [1, { b: 2n }] }],
    ['a function', () => 1],
    ['NaN', Number.NaN],
    ['Infinity', { x: Infinity }],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a symbol', Symbol('s')],
    ['a cycle', cyclic],
  ];
  for (const [what, value] of bad) {
    it(`refuses ${what} in a node payload`, () => {
      const r = applyDelta(createGroupSpace(), { upsertNodes: [{ id: n('a'), payload: value }] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.violations[0]!.code).toBe('malformed');
    });
  }

  it('refuses a BigInt in edge meta', () => {
    const r = applyDelta(createGroupSpace(), {
      added: [{ id: 'e' as never, parent: n('p'), child: n('c'), kind: 'contains', meta: { n: 1n } }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe('malformed');
  });

  it('accepts nested plain data, null and undefined fields', () => {
    const payload = { a: [1, 'two', null, { b: true }], c: undefined, d: Object.create(null) };
    expect(applyDelta(createGroupSpace(), { upsertNodes: [{ id: n('a'), payload }] }).ok).toBe(true);
  });
});

describe('nothing in a delta can make applyDelta throw', () => {
  it('a BigInt id, family or tombstone payload is reported, not thrown', () => {
    const s = createGroupSpace({ nodes: [{ id: n('a'), label: 'A' }] });
    expect(() => applyDelta(s, { upsertNodes: [{ id: 5n as never }] })).not.toThrow();
    expect(() => applyDelta(s, { upsertNodes: [{ id: n('a'), family: { maxPerItem: 1n as never } }] })).not.toThrow();
    const r = applyDelta(s, { removedNodes: [{ id: n('a'), payload: 1n }] });
    expect(r.ok).toBe(false);
  });
});
