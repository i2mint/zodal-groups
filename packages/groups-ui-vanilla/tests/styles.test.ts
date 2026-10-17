/**
 * The stylesheet's touch and typography contract, checked on the rules as written (jsdom does no
 * media-query cascade). A host page should still measure in a real browser at phone width.
 *
 * - no root sets `font`, `font-family` or `line-height`: the host's typography wins;
 * - every `:hover` is inside `@media (hover: hover)`;
 * - under `(pointer: coarse)`: rows, options, chips and buttons get a 44px floor, the twisty is 44px
 *   wide, and every text input is at least 16px (iOS zooms on focus below that).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

interface Rule {
  readonly selectors: readonly string[];
  readonly media: readonly string[];
  readonly decls: ReadonlyMap<string, string>;
}

/** A small CSS reader: rules with their enclosing @media preludes. Enough for one flat stylesheet. */
function parse(text: string): Rule[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const ch of source) {
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      const prelude = stack.pop() ?? '';
      if (!prelude.startsWith('@')) {
        const decls = new Map<string, string>();
        for (const part of buffer.split(';')) {
          const i = part.indexOf(':');
          if (i > 0) decls.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
        }
        rules.push({
          selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
          media: stack.filter((p) => p.startsWith('@media')),
          decls,
        });
      }
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return rules;
}

const rules = parse(css);
const ROOTS = ['.zg-tree', '.zg-columns', '.zg-breadcrumbs', '.zg-facets', '.zg-tags', '.zg-tagmenu', '.zg-group-chips'];
const coarse = rules.filter((r) => r.media.some((m) => m.includes('(pointer: coarse)')));
const coarseDecl = (selector: string, prop: string): string | undefined =>
  coarse.find((r) => r.selectors.includes(selector) && r.decls.has(prop))?.decls.get(prop);

describe('styles.css', () => {
  it('parses into rules (the reader works)', () => {
    expect(rules.length).toBeGreaterThan(50);
  });

  it.each(ROOTS)('%s inherits the host typography, sized by --zg-font-size', (root) => {
    const own = rules.filter((r) => r.selectors.includes(root));
    expect(own.length).toBeGreaterThan(0);
    for (const rule of own) {
      expect(rule.decls.has('font')).toBe(false);
      expect(rule.decls.has('font-family')).toBe(false);
      expect(rule.decls.has('line-height')).toBe(false);
    }
    expect(own.some((r) => r.decls.get('font-size') === 'var(--zg-font-size, inherit)')).toBe(true);
  });

  it('never names a font family anywhere, and the font shorthand only ever inherits', () => {
    for (const rule of rules) {
      expect(rule.decls.has('font-family')).toBe(false);
      const font = rule.decls.get('font');
      if (font !== undefined) expect(font).toBe('inherit');
    }
  });

  it('every :hover is inside @media (hover: hover)', () => {
    const hovers = rules.filter((r) => r.selectors.some((s) => s.includes(':hover')));
    expect(hovers.length).toBeGreaterThan(0);
    for (const rule of hovers) expect(rule.media.some((m) => m.includes('(hover: hover)'))).toBe(true);
  });

  it.each([
    '.zg-row', '.zg-column-row', '.zg-facet', '.zg-tag-option', '.zg-tagmenu-option', '.zg-group-chip',
    '.zg-crumb', '.zg-other-paths', '.zg-tagmenu-actions button', '.zg-tag-input', '.zg-tagmenu-search',
  ])('on a coarse pointer, %s is at least 44px tall', (selector) => {
    expect(coarseDecl(selector, 'min-height')).toBe('var(--zg-row-min, var(--zg-tap-min, 44px))');
  });

  it('on a coarse pointer, the twisty and the chip remove button are 44px wide', () => {
    expect(coarseDecl('.zg-row > .zg-twisty', 'width')).toBe('var(--zg-twisty-width, var(--zg-tap-min, 44px))');
    expect(coarseDecl('.zg-chip-remove', 'min-width')).toBe('var(--zg-tap-min, 44px)');
  });

  it('the twisty is the full row height', () => {
    const twisty = rules.find((r) => r.selectors.includes('.zg-row > .zg-twisty') && !r.media.length)!;
    expect(twisty.decls.get('align-self')).toBe('stretch');
  });

  it.each(['.zg-tag-input', '.zg-tagmenu-search'])('on a coarse pointer, %s is at least 16px (no iOS focus zoom)', (selector) => {
    expect(coarseDecl(selector, 'font-size')).toBe('max(16px, 1em)');
  });

  it('touch rows are visibly separated', () => {
    expect(coarseDecl('.zg-row', 'border-bottom')).toContain('var(--zg-separator');
  });
});
