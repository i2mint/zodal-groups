/**
 * `@zodal/groups-store-fs` — a Node filesystem `GroupStore`: the group DAG and every membership in
 * one **sidecar manifest** (a JSON file), never in the directory structure.
 *
 * ```ts
 * import { createFsGroupStore } from '@zodal/groups-store-fs';
 *
 * const store = createFsGroupStore({ path: '/data/photos/.groups.json', profile: 'labels' });
 * await store.apply({ added: [makeEdge(nodeId('holiday'), nodeId('img-001.jpg'))] });
 * const space = await store.load();          // a GroupSpace — hand it to any projection
 * ```
 *
 * Why a manifest and not symlinks or nested folders (reconciliation §6.5): hard links to directories
 * are forbidden by the OS, and symlinks make cycles *your* bug — the filesystem cannot express a
 * polyhierarchy safely, so the hierarchy lives in data the library validates.
 *
 * The write path is hardened the way zodal-dials' `dials-store-jsonc` is:
 *
 * - **atomic** — each save writes a temp file in the same directory, fsyncs it, and renames it over
 *   the manifest, so a crash leaves the old manifest or the new one, never half of one;
 * - **serialized** — saves to one manifest are queued, across every store instance in the process,
 *   so concurrent `apply`s never lose an update (read–modify–write under one queue);
 * - **parent directory created** on first write;
 * - **a corrupt manifest is an error, never an empty space** — invalid JSON, an empty file, a file
 *   that is not a zodal-groups manifest, a newer format, or a malformed node/edge all reject with a
 *   `ManifestError` naming the file and the problem, and nothing is written over it.
 *
 * Each `load`/`apply` re-reads the manifest, so edits made between operations (by hand, by another
 * tool) are seen. Writers in *other processes* are not coordinated — there is no file locking; keep
 * one writing process per manifest.
 *
 * Data on disk is not validated against the profile on read (D8: enforce on write, never trust on
 * read); `validateProfile` / `inferProfile` from groups-core report what shape it is in.
 *
 * @see `@zodal/groups-core` `GroupStore` for the contract; this adapter runs its test-kit.
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CLIENT_SIDE_CAPABILITIES,
  commitDelta,
  createListenerSet,
  fromSnapshot,
  parseSnapshot,
  toSnapshot,
  type GroupProfile,
  type GroupSnapshot,
  type GroupSpace,
  type GroupStore,
  type GroupStoreChange,
  type ProfileName,
} from '@zodal/groups-core';

/** The `format` marker every manifest carries. */
export const MANIFEST_FORMAT = 'zodal-groups/manifest';
/** The manifest format version this package writes, and the newest it reads. */
export const MANIFEST_VERSION = 1;

/** The manifest file is unreadable as a zodal-groups manifest. Never treated as an empty space. */
export class ManifestError extends Error {
  readonly path: string;
  constructor(path: string, problem: string, options?: { cause?: unknown }) {
    super(
      `${path}: ${problem}. The manifest was left untouched and was not treated as empty — ` +
        'repair it, or move it aside to start a new one.',
      options,
    );
    this.name = 'ManifestError';
    this.path = path;
  }
}

/** File access, injectable for tests and non-default hosts. */
export interface ManifestIO {
  /** The file's text, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Replace the file's contents atomically, creating its parent directory if needed. */
  write(path: string, text: string): Promise<void>;
}

let tempCounter = 0;

/** The default `ManifestIO`: Node fs, with an fsynced temp file renamed over the target. */
export function nodeManifestIO(): ManifestIO {
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(path, text) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      // Same directory ⇒ same filesystem ⇒ `rename` is atomic.
      const temp = join(dir, `.${basename(path)}.${process.pid}.${(tempCounter += 1)}.tmp`);
      try {
        const handle = await open(temp, 'w');
        try {
          await handle.writeFile(text, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

export interface FsGroupStoreOptions {
  /** The manifest file. Its parent directory is created on first write. */
  readonly path: string;
  /** The profile every write is validated against. Defaults to `polyhierarchy`. */
  readonly profile?: ProfileName | GroupProfile;
  readonly overrides?: Partial<Omit<GroupProfile, 'name'>>;
  /** File access. Defaults to `nodeManifestIO()`. */
  readonly io?: ManifestIO;
  /** `JSON.stringify` indentation. Defaults to 2 — the manifest is meant to be diffable. */
  readonly indent?: number | string;
  /** Where a throwing `subscribe` listener's error goes. Defaults to `console.error`. */
  readonly onListenerError?: (error: unknown) => void;
}

/** A `GroupStore` over one manifest file. `path` is the resolved manifest path. */
export interface FsGroupStore<P = unknown> extends GroupStore<P> {
  readonly path: string;
}

/** One queue per manifest, shared by every store instance in this process. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  // Drop the entry once idle, so a long-lived process does not keep one per file forever.
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

/** Create a `GroupStore` persisted as a sidecar manifest. See the module docstring. */
export function createFsGroupStore<P = unknown>(options: FsGroupStoreOptions): FsGroupStore<P> {
  const path = resolve(options.path);
  const io = options.io ?? nodeManifestIO();
  const indent = options.indent ?? 2;
  const empty = fromSnapshot<P>(
    { nodes: [], edges: [] },
    {
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    },
  );
  const profile = empty.profile;
  const listeners = createListenerSet<GroupStoreChange>(options.onListenerError);

  const read = async (): Promise<GroupSpace<P>> => {
    const text = await io.read(path);
    if (text === undefined) return empty;
    if (text.trim() === '') throw new ManifestError(path, 'the manifest is empty');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ManifestError(path, `the manifest is not valid JSON (${(error as Error).message})`, { cause: error });
    }
    const record = json as Record<string, unknown> | null;
    if (typeof record !== 'object' || record === null || record.format !== MANIFEST_FORMAT) {
      throw new ManifestError(path, `not a zodal-groups manifest (expected "format": "${MANIFEST_FORMAT}")`);
    }
    if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1) {
      throw new ManifestError(path, `"version" must be a positive integer, got ${JSON.stringify(record.version)}`);
    }
    if (record.version > MANIFEST_VERSION) {
      throw new ManifestError(
        path,
        `manifest version ${record.version} is newer than this package reads (${MANIFEST_VERSION}); upgrade @zodal/groups-store-fs`,
      );
    }
    let snapshot;
    try {
      snapshot = parseSnapshot<P>(record);
    } catch (error) {
      throw new ManifestError(path, `malformed manifest: ${(error as Error).message}`, { cause: error });
    }
    return fromSnapshot(snapshot, { profile });
  };

  const serialize = (space: GroupSpace<P>): string => serializeManifest(toSnapshot(space), { indent });

  return {
    path,
    profile,
    load: () => enqueue(path, read),
    apply: (delta, applyOptions) =>
      enqueue(path, async () => {
        // Read, check the revision, compute the inverse and apply — all inside the queue, against
        // the state actually on disk (B1: an inverse computed from an earlier read undoes the
        // wrong state).
        const result = commitDelta(await read(), delta, applyOptions);
        if (!result.ok) return result;
        await io.write(path, serialize(result.value.space));
        listeners.emit({ delta, inverse: result.value.inverse, revision: result.value.revision });
        return result;
      }),
    getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
    subscribe: (listener) => listeners.add(listener),
    dispose: () => listeners.clear(),
  };
}

/**
 * A snapshot as manifest text — what the store writes. Exported for tools that seed or migrate a
 * manifest without going through `apply` (an importer, a test fixture of foreign data).
 */
export function serializeManifest(
  snapshot: GroupSnapshot,
  options: { readonly indent?: number | string; readonly extra?: Readonly<Record<string, unknown>> } = {},
): string {
  const { revision = 0, nodes, edges } = snapshot;
  const manifest = { ...(options.extra ?? {}), format: MANIFEST_FORMAT, version: MANIFEST_VERSION, revision, nodes, edges };
  return `${JSON.stringify(manifest, null, options.indent ?? 2)}\n`;
}
