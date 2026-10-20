/** The tag menu shows the alias a row matched (#57, `TagRow.matchedAlias`), as the tag input does. */
import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, edgeId, makeEdge, nodeId } from '@zodal/groups-core';
import { renderTagMenu } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const build = () => {
  const g = defineGroups({ profile: 'labels' });
  g.add('a', 'todo');
  g.add('b', 'tonal');
  g.apply({ added: [makeEdge(nodeId('todo'), nodeId('to-do'), { id: edgeId('todo>to-do'), kind: 'alias_of' })] });
  return g;
};
const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const option = (group: string) => container.querySelector<HTMLElement>(`[role="option"][data-key="${group}"]`)!;
const alias = (group: string) => option(group).querySelector<HTMLElement>('.zg-tagmenu-alias')!;

describe('tag menu and aliases', () => {
  it('a row found through an alias shows it, in sight and in its name; the hint goes when the search no longer needs it', () => {
    const menu = renderTagMenu(container, build(), { selection: ['a', 'b'] });
    expect(alias('todo').hidden).toBe(true);
    type(menu.search, 'to-');
    expect(alias('todo').hidden).toBe(false);
    expect(alias('todo').textContent).toBe('to-do');
    expect(option('todo').getAttribute('aria-label')).toContain('also called');
    expect(option('todo').getAttribute('aria-label')).toContain('to-do');
    type(menu.search, 'tod');
    expect(alias('todo').hidden).toBe(true);
    expect(option('todo').getAttribute('aria-label')).not.toContain('also called');
  });
});
