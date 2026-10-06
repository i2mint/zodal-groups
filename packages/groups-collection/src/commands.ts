/**
 * The tagging operations, declared twice with shared ids — the fleet's rule, "operations in
 * commands":
 *
 * - **`operations`**: `OperationDefinition[]` from `@zodal/core`, declarative (name, label, scope,
 *   icon, destructive style, confirmation). Renderers list them.
 * - **`commands`**: the same operations in acture's `CommandRecord` shape (`id`, `title`, Zod
 *   `params`, `execute → Result`), bound to one tagged collection. Register them in any acture
 *   registry (`registry.register(defineCommand(cmd))`) — or call `execute` directly. No acture
 *   dependency: the shape is structural.
 *
 * A command's successful result carries the operation's `OperationResult` as its `value`, and its
 * inverse as an effect (`{ type: INVERSE_EFFECT, inverse }`), which is how acture-undo's
 * `onEffect` hands it back on undo: call `tc.revert(effect.inverse)`. A command whose every item
 * failed returns `{ ok: false, error }` (`error.details.failed` lists them); a partial success is
 * `ok: true` with `value.failed` non-empty — partial stays applied.
 *
 * acture has no confirmation step: `deleteItem` and `deleteGroup` are `confirm: true` in
 * `operations`, but a palette, hotkey or AI caller runs the command directly. Gate them with `when`
 * in your registry if that matters.
 *
 * // switch to toCommandRecord / operationCommandId from @zodal/core once 0.2.2 is published
 */

import { z, type ZodType } from 'zod';
import type { OperationDefinition } from '@zodal/core';
import type { OperationResult, TaggedCollection } from './types.js';

/** A state patch (acture's `Patch`). */
export interface CommandPatch {
  op: 'add' | 'remove' | 'replace';
  path: readonly (string | number)[];
  value?: unknown;
}

/** A side effect for an undo/effect queue (acture's `Effect`). */
export interface CommandEffect {
  type: string;
  [key: string]: unknown;
}

/** What `execute` resolves to (acture's `Result`). */
export type CommandResult<R> =
  | { ok: true; value: R; patches?: readonly CommandPatch[]; effects?: readonly CommandEffect[] }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** A command in acture's `CommandRecord` shape (the fields this package sets). */
export interface GroupsCommand<P = any, R = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
  readonly icon?: string;
  readonly params: ZodType<P>;
  readonly execute: (params: P, ctx?: Record<string, unknown>) => Promise<CommandResult<R>>;
}

/**
 * The effect type carrying an operation's inverse: `{ type, inverse, collection }`, where
 * `collection` is the command namespace — route `revert` to the collection it names.
 */
export const INVERSE_EFFECT = 'groupsCollection.inverse';

/** The declarative operations. Names are also the last segment of the command ids. */
export const operations: readonly OperationDefinition[] = Object.freeze([
  { name: 'create', label: 'New item in groups', scope: 'collection', icon: 'plus' },
  { name: 'tag', label: 'Add to group', scope: 'selection', icon: 'tag' },
  { name: 'untag', label: 'Remove from group', scope: 'selection', icon: 'tag' },
  { name: 'bulkTag', label: 'Edit groups', scope: 'selection', icon: 'tags' },
  { name: 'removeFromGroup', label: 'Remove from this group', scope: 'item', icon: 'x' },
  { name: 'deleteItem', label: 'Delete item', scope: 'item', icon: 'trash-2', variant: 'destructive', confirm: true },
  { name: 'renameGroup', label: 'Rename group', scope: 'collection', icon: 'pencil' },
  { name: 'mergeGroups', label: 'Merge groups', scope: 'collection', icon: 'merge' },
  { name: 'moveInGroup', label: 'Move within group', scope: 'item', icon: 'arrow-up-down' },
  { name: 'deleteGroup', label: 'Delete group', scope: 'collection', icon: 'trash-2', variant: 'destructive', confirm: true },
] satisfies OperationDefinition[]);

/**
 * One acture id segment: `bulk-delete` → `bulkDelete`, `Archive` → `archive`. ASCII only. Same
 * normalization as `@zodal/core`'s `operationCommandId` (0.2.2).
 */
function idSegment(name: string): string {
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`"${name}" must be printable ASCII to become a command id.`);
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!words.length) throw new Error(`"${name}" has no letters or digits.`);
  const seg = words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
  if (!/^[a-z]/.test(seg)) throw new Error(`"${name}" must start with a letter.`);
  return seg;
}

/** `namespace.operationName`, normalized to acture's `app.domain.action` (dot-separated camelCase). */
export function commandId(namespace: string | undefined, name: string): string {
  const ns = namespace ? namespace.split('.').map(idSegment).join('.') : '';
  return ns ? `${ns}.${idSegment(name)}` : idSegment(name);
}

const ids = z.array(z.string().min(1)).min(1);
const space = z.string().min(1).optional();

/** The parameters of each command (JSON-Schema-representable, as acture requires). */
export const commandParams = {
  create: z.object({
    item: z.record(z.string(), z.unknown()),
    groups: z.union([z.array(z.string().min(1)), z.record(z.string(), z.array(z.string().min(1)))]).optional(),
  }),
  tag: z.object({ ids, group: z.string().min(1), space, kind: z.string().min(1).optional() }),
  untag: z.object({ ids, group: z.string().min(1), space }),
  bulkTag: z.object({
    ids,
    add: z.array(z.string().min(1)).optional(),
    remove: z.array(z.string().min(1)).optional(),
    labels: z.record(z.string(), z.string().min(1)).optional(),
    space,
  }),
  removeFromGroup: z.object({ id: z.string().min(1), group: z.string().min(1), space }),
  deleteItem: z.object({ id: z.string().min(1) }),
  renameGroup: z.object({ group: z.string().min(1), name: z.string().min(1), space, by: z.enum(['label', 'id']).optional() }),
  mergeGroups: z.object({ from: z.string().min(1), into: z.string().min(1), space }),
  moveInGroup: z.object({ id: z.string().min(1), group: z.string().min(1), before: z.string().min(1).optional(), after: z.string().min(1).optional(), space }),
  deleteGroup: z.object({ group: z.string().min(1), space }),
} as const;

type Params = { [K in keyof typeof commandParams]: z.infer<(typeof commandParams)[K]> };

/** Turn an operation result into acture's `Result`: the inverse rides along as an effect. */
export function toCommandResult<T>(result: OperationResult<T>, collection = 'groups'): CommandResult<OperationResult<T>> {
  if (!result.succeeded.length && result.failed.length) {
    const first = result.failed[0]!;
    const message = result.failed.length === 1 ? first.reason : `${result.failed.length} failed; first: ${first.id}: ${first.reason}`;
    return { ok: false, error: { code: first.code, message, details: { failed: result.failed } } };
  }
  const changed = result.inverse.items.length > 0 || Object.keys(result.inverse.shared).length > 0;
  return { ok: true, value: result, ...(changed ? { effects: [{ type: INVERSE_EFFECT, inverse: result.inverse, collection }] } : {}) };
}

export interface CreateCommandsOptions {
  /** First segment(s) of every id. Default `'groups'`. */
  readonly namespace?: string;
  /** Palette grouping. Default: none. */
  readonly category?: string;
}

/** The commands for one tagged collection, in `operations` order. */
export function createCommands<T extends Record<string, unknown>>(
  tc: TaggedCollection<T>,
  options: CreateCommandsOptions = {},
): readonly GroupsCommand[] {
  const handlers: { [K in keyof Params]: (p: Params[K]) => Promise<OperationResult<T>> } = {
    create: (p) => tc.create(p.item as Partial<T>, p.groups !== undefined ? { groups: p.groups } : {}),
    tag: (p) => tc.tag(p.ids, p.group, { ...(p.space ? { space: p.space } : {}), ...(p.kind ? { kind: p.kind } : {}) }),
    untag: (p) => tc.untag(p.ids, p.group, p.space ? { space: p.space } : {}),
    bulkTag: (p) =>
      tc.bulkTag(p.ids, {
        ...(p.add ? { add: p.add } : {}),
        ...(p.remove ? { remove: p.remove } : {}),
        ...(p.labels ? { labels: p.labels } : {}),
        ...(p.space ? { space: p.space } : {}),
      }),
    removeFromGroup: (p) => tc.removeFromGroup(p.id, p.group, p.space ? { space: p.space } : {}),
    deleteItem: (p) => tc.deleteItem(p.id),
    renameGroup: (p) => tc.renameGroup(p.group, p.name, { ...(p.space ? { space: p.space } : {}), ...(p.by ? { by: p.by } : {}) }),
    mergeGroups: (p) => tc.mergeGroups(p.from, p.into, p.space ? { space: p.space } : {}),
    moveInGroup: (p) => {
      if ((p.before === undefined) === (p.after === undefined)) throw new Error('moveInGroup needs exactly one of `before` or `after`.');
      const where = p.before !== undefined ? { before: p.before } : { after: p.after! };
      return tc.moveInGroup(p.id, p.group, { ...where, ...(p.space ? { space: p.space } : {}) });
    },
    deleteGroup: (p) => tc.deleteGroup(p.group, p.space ? { space: p.space } : {}),
  };
  const namespace = options.namespace ?? 'groups';
  return Object.freeze(
    operations.map((op) => {
      const name = op.name as keyof Params;
      const params = commandParams[name] as ZodType<unknown>;
      const command: GroupsCommand = {
        id: commandId(namespace, op.name),
        title: op.label,
        ...(options.category ? { category: options.category } : {}),
        ...(op.icon ? { icon: op.icon } : {}),
        params,
        async execute(raw) {
          const parsed = params.safeParse(raw);
          if (!parsed.success) {
            return { ok: false, error: { code: 'invalid_params', message: parsed.error.message, details: parsed.error.issues } };
          }
          try {
            return toCommandResult(await (handlers[name] as (p: unknown) => Promise<OperationResult<T>>)(parsed.data), namespace);
          } catch (err) {
            // acture's code for a throw inside execute; never the raw error object.
            return { ok: false, error: { code: 'execute_threw', message: err instanceof Error ? err.message : String(err) } };
          }
        },
      };
      return Object.freeze(command);
    }),
  );
}
