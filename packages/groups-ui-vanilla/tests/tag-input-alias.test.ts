/** The tag input resolves aliases on read (#51, D34): typing `to-do` offers `todo`, once, and Enter picks it. */
import { beforeEach, describe, expect, it } from 'vitest';
import { defineGroups, edgeId, makeEdge, nodeId } from '@zodal/groups-core';
import { renderTagInput } from '../src/index.js';

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const build = () => {
  const g = defineGroups({ profile: 'labels' });
  g.add('song-9', 'todo');
  g.add('song-8', 'tonal');
  g.apply({ added: [makeEdge(nodeId('todo'), nodeId('to-do'), { id: edgeId('todo>to-do'), kind: 'alias_of' })] });
  return g;
};
const input = () => container.querySelector<HTMLInputElement>('.zg-tag-input')!;
const typeText = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event('input'));
};
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];

describe('tag input and aliases', () => {
  it('offers the canonical group once for an alias, marked with the alias, and Enter picks it', () => {
    const g = build();
    renderTagInput(container, g).show(nodeId('song-1'));
    typeText('to-');
    expect(options().map((o) => o.textContent)).toEqual(['todoto-do', expect.stringContaining('to-')]);
    expect(options()[0]!.querySelector('.zg-tag-option-alias')!.textContent).toBe('to-do');
    typeText('TO-DO');
    expect(options().filter((o) => o.textContent!.startsWith('todo'))).toHaveLength(1);
    expect(options().some((o) => o.classList.contains('zg-tag-create'))).toBe(false);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(g.parents(nodeId('song-1'))).toEqual(['todo']);
  });
});
