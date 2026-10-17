# @zodal/groups-ui-vanilla

Zero-dependency DOM renderers for [zodal-groups](https://github.com/i2mint/zodal-groups): a tree, Miller columns, breadcrumbs, facets, group chips, a tag input and the selection tagging menu. Plain DOM, no framework, no build step needed.

```ts
import { defineGroups } from '@zodal/groups-core';
import { renderTree, renderGroupChips, renderTagInput } from '@zodal/groups-ui-vanilla';
import '@zodal/groups-ui-vanilla/styles.css';

const groups = defineGroups({ profile: 'polyhierarchy' });
renderTree(el, groups);          // a tree: tap a group to open it, arrow keys, drag with a mouse
renderGroupChips(el, groups);    // on a phone: All · groups with counts · Ungrouped, drill down
renderTagInput(el, groups).show(itemId);  // an item's groups as chips, plus a "add to group" field
```

## Typography and touch

The widgets take the host page's typography: no root sets `font`, `font-family` or `line-height`, so they render in your font at your size. On a fine pointer (mouse, trackpad) they keep a desktop density. On a coarse pointer (`@media (pointer: coarse)`) every row, option, chip and button is at least 44px tall, the tree's expander is 44px wide and the full row height, rows are separated by a line, and every text input is at least 16px (iOS Safari zooms the page when a smaller input takes focus). Hover styles apply only under `@media (hover: hover)`, and drag-and-drop is offered only under `(pointer: fine)`.

Tune them with CSS custom properties, set on any ancestor:

| property | what | default |
|---|---|---|
| `--zg-font-size` | the widgets' font size | `inherit` |
| `--zg-row-min` | min height of rows, options, chips, buttons | `auto`; on a coarse pointer never below `--zg-tap-min` |
| `--zg-tap-min` | the coarse-pointer target floor | `44px` |
| `--zg-twisty-width` | the tree expander's width | `1.25em` (fine), `--zg-tap-min` (coarse) |
| `--zg-indent` | tree indent per level | `1.1rem` |
| `--zg-separator` | the line between rows on touch | `1px solid` text colour at 12% |
| `--zg-chips-wrap` | group chip rows wrap (`wrap`) or scroll sideways (`nowrap`) | `nowrap` |
| `--zg-surface`, `--zg-surface-text` | the tag input's suggestion popup | `Canvas`, `CanvasText` |
| `--zg-danger` | the tag menu's warning hue | `#e03131` |

## renderTree

```ts
renderTree(el, groups, {
  groupActivate: 'toggle',        // tapping a group's name opens it (default); 'select' selects it
  subtitle: (row) => artistOf(row.nodeId),           // a muted second line, also read out
  renderLabel: (row, el) => { el.innerHTML = '…'; }, // or draw the label yourself
  onSelect: (nodeId, row) => open(nodeId),
});
```

- `groupActivate`: what a click, tap, Enter or Space on a group row does. `'toggle'` (default) expands or collapses it and selects nothing (`onToggle(nodeId, expanded, row)` reports it); `'select'` selects it (the twisty still expands). Rows without children are always selected. This changes the old behaviour, where a click on a group selected it: pass `'select'` to keep that.
- `subtitle(row)`: a second, muted line (`.zg-label-title` + `.zg-label-subtitle`), added to the row's accessible name. Return `undefined` for none.
- `renderLabel(row, el)`: fill the empty `.zg-label` span yourself. Wins over `subtitle`. Buttons, links and inputs you put there keep their own clicks and keys. The accessible name stays `row.aria.label` (which says "also in N other groups") unless you pass `ariaLabel(row)`.
- `draggable` (default `true`): drag-and-drop where the pointer is fine; never on touch. `false` turns it off.
- `label`: the tree's accessible name.
- Keyboard (WAI-ARIA tree pattern): one tab stop (the focused row, else the selected one, else the first), Up/Down move, Right expands or goes to the first child, Left collapses or goes to the parent, Home/End, Enter/Space activate.

## renderGroupChips

The phone way to browse nested groups. The first row is `All · <root groups, with counts> · Ungrouped` (Ungrouped is everything no group reaches, so All is always the groups plus Ungrouped); choosing a group that has subgroups adds a row `All of <group> · <its subgroups>`. Counts are de-duplicated over the closure (an item in two subgroups counts once). The state is one selection, `{ path, ungrouped }`, which you can keep in the URL.

```ts
const chips = renderGroupChips(el, groups, {
  items: () => songs.map((s) => s.id),   // what to count and filter; ids not in the space are ungrouped
  selection: { path: fromUrl() },        // root-first group ids; a lone subgroup id is expanded to its path
  onNavigate: (selection) => {           // the user chose a chip (or the chosen group was deleted)
    history.pushState(null, '', toUrl(selection));
    showSongs(chips.items());            // the ids the selection matches, in pool order
  },
});
window.addEventListener('popstate', () => chips.setSelection({ path: fromUrl() }));  // no echo
```

- Options: `selection`, `items` (a list or a function read on each render), `onNavigate(selection)`, `ungrouped` (offer the chip, default `true`), `hideEmpty` (default `true`; the chosen chip always stays), `sort` (`'label'`, default, or `'count'`), `labels` (`all`, `allOf`, `ungrouped`, `rootRow`, `subRow`, `count`), `label` (the widget's accessible name).
- Returns `{ selection, setSelection(sel) → normalized, items(), render(), destroy(), element }`. `setSelection` drops an invalid tail and never calls `onNavigate`.
- Each chip is a `<button aria-pressed>` whose accessible name carries the count; each row is a labelled `role="group"`.
- The rows come from `toGroupChips` in `@zodal/groups-ui`, so other renderers draw the same thing. It is the phone counterpart of the facet sidebar planned in [#15](https://github.com/i2mint/zodal-groups/issues/15).

## renderTagInput

An item's groups as removable chips, and a field to add it to another group. The field is a combobox: typing lists matching groups, and when no group has that exact name, an explicit **Create "…"** option.

- Enter picks the group the text names (case-insensitively), or the only group the text is a prefix of. With no match, or several, it creates nothing and says why in the status line. Creating a group is choosing the Create option (tap it, or arrow to it and press Enter), never a side effect of Enter on a typo.
- The field is built once: what you type, and focus, survive every redraw, including a rollback.
- Options: `onWrite(delta)` to persist (an edit applies at once; a rejected write is rolled back with the edits queued behind it), `onError`, `onChange`, `maxSuggestions` (default 8), `labels` (`placeholder`, `inputLabel`, `suggestions`, `create`, `noMatch`, `ambiguous`, `alreadyIn`; `TAG_INPUT_LABELS` has the defaults).

## The others

`renderColumns` (Miller columns, the best view for a polyhierarchy), `renderBreadcrumbs`, `renderFacets`, `renderTagMenu` (Gmail's label menu over a selection: tri-state per group, staged until "Apply to N items") and `createVanillaRegistry()` (pick a renderer by surface and profile) are described in their module docs and in the [repository README](../../README.md).
