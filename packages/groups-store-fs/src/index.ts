/**
 * `@zodal/groups-store-fs` — a Node filesystem `GroupStore`: the group DAG and every membership in
 * one **sidecar manifest** (a JSON file), never in the directory structure.
 *
 * ```ts
 * import { createFsGroupStore } from '@zodal/groups-store-fs';
 *
 * const store = createFsGroupStore({ path: '/data/photos/.groups.json', profile: 'labels' });
 * const r = await store.apply({ added: [makeEdge(nodeId('holiday'), nodeId('img-001.jpg'))] });
 * const space = await store.load();          // a GroupSpace — hand it to any projection
 * ```
 *
 * Why a manifest and not symlinks or nested folders (reconciliation §6.5): hard links to directories
 * are forbidden by the OS, and symlinks make cycles *your* bug — the filesystem cannot express a
 * polyhierarchy safely, so the hierarchy lives in data the library validates.
 *
 * The write path:
 *
 * - **atomic** — each save writes a temp file in the same directory (exclusive create), fsyncs it,
 *   renames it over the manifest, then fsyncs the directory, so a crash leaves the old manifest or
 *   the new one, never half of one;
 * - **serialized per real file** — saves are queued by the manifest's `realpath`, across every store
 *   instance in the process, so two stores reaching one file through a symlinked directory never
 *   lose an update; a symlinked manifest stays a symlink (its target is replaced);
 * - **another process is detected, not overwritten** — just before the rename the manifest is
 *   re-read; if it changed since this write read it, the write is abandoned and `apply` returns a
 *   `conflict` violation. (Detection, not locking: the check-to-rename window is microseconds wide,
 *   not zero. Keep one writing process per manifest for guarantees.)
 * - **the file mode is kept** (a `0600` manifest stays `0600`; `mode` sets it for a new one);
 * - **stale temp files** a dead process left behind are removed (once per manifest per process);
 * - **parent directory created** on first write;
 * - **a corrupt manifest is an error, never an empty space** — invalid JSON, an empty file, a file
 *   that is not a zodal-groups manifest, a newer format, a version with no migration, or a
 *   malformed node/edge all reject with a `ManifestError` naming the file, and nothing is written
 *   over it;
 * - **forward-compatible** — top-level fields this version does not know are kept on every write,
 *   and older versions are upgraded through a `migrations` map keyed by version.
 *
 * Each `load`/`apply` re-reads the manifest, so edits made between operations (by hand, by another
 * tool) are seen. Data on disk is not validated against the profile on read (D8: enforce on write,
 * never trust on read); `validateProfile` / `inferProfile` from groups-core report its shape.
 *
 * @see `@zodal/groups-core` `GroupStore` for the contract; this adapter runs its test-kit.
 */

import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
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

/** A manifest as parsed JSON, before (or after) migration. */
export type ManifestRecord = Record<string, unknown>;
/** Upgrades a manifest from the version it is keyed by to the next one (`version` + 1). */
export type ManifestMigration = (manifest: ManifestRecord) => ManifestRecord;
/** The built-in migrations. Empty: version 1 is the first released format. */
export const MANIFEST_MIGRATIONS: Readonly<Record<number, ManifestMigration>> = Object.freeze({});

/** The fields the manifest format owns; any other top-level field is kept as is. */
const OWN_FIELDS = new Set(['format', 'version', 'revision', 'nodes', 'edges']);

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

/** The manifest changed between this write's read and its rename — another writer got there first. */
export class ManifestConflictError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path}: the manifest changed while this write was in progress (another process?). Nothing was written.`);
    this.name = 'ManifestConflictError';
    this.path = path;
  }
}

export interface ManifestWriteOptions {
  /**
   * Write only if the file still holds exactly this text (`null`: only if it does not exist);
   * otherwise throw `ManifestConflictError`. A custom `ManifestIO` that ignores it loses
   * other-process detection, nothing else.
   */
  readonly ifUnchanged?: string | null;
  /** Mode for a newly created file. An existing file keeps its own mode. */
  readonly mode?: number;
}

/** File access, injectable for tests and non-default hosts. */
export interface ManifestIO {
  /** The file's text, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Replace the file's contents atomically, creating its parent directory if needed. */
  write(path: string, text: string, options?: ManifestWriteOptions): Promise<void>;
}

let tempCounter = 0;

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Best effort: make the rename itself durable. Not every platform can fsync a directory. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* e.g. Windows (EPERM/EISDIR) — the rename is still atomic, only its durability is weaker */
  }
}

/** The default `ManifestIO`: Node fs, with an fsynced temp file renamed over the target. */
export function nodeManifestIO(): ManifestIO {
  return {
    read: readText,
    async write(path, text, options = {}) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      let mode: number | undefined = options.mode;
      try {
        mode = (await stat(path)).mode & 0o7777; // keep the existing file's mode
      } catch (error) {
        if (errno(error) !== 'ENOENT') throw error;
      }
      // Same directory ⇒ same filesystem ⇒ `rename` is atomic. The pid in the name lets a later
      // run tell a dead process's leftover from a live writer's (see `removeStaleTemps`).
      const temp = join(dir, `.${basename(path)}.${process.pid}.${(tempCounter += 1)}.tmp`);
      try {
        const handle = await open(temp, 'wx', mode ?? 0o666);
        try {
          await handle.writeFile(text, 'utf8');
          if (mode !== undefined) await handle.chmod(mode); // exact, whatever the umask
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (options.ifUnchanged !== undefined) {
          const current = (await readText(path)) ?? null;
          if (current !== options.ifUnchanged) throw new ManifestConflictError(path);
        }
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await syncDirectory(dir);
    },
  };
}

/**
 * The file a path really names: symlinks resolved, including a symlinked manifest and symlinked
 * ancestors of a manifest that does not exist yet. Queues and renames are keyed on this, so two
 * routes to one file share one queue and a symlink is never replaced by a regular file.
 */
export async function realTarget(path: string, hops = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  try {
    if (hops < 40 && (await lstat(path)).isSymbolicLink()) {
      return realTarget(resolve(dirname(path), await readlink(path)), hops + 1); // a dangling link
    }
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  const rest = [basename(path)];
  let dir = dirname(path);
  for (;;) {
    try {
      return join(await realpath(dir), ...rest);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return path;
    rest.unshift(basename(dir));
    dir = parent;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === 'EPERM'; // exists, just not ours to signal
  }
};

/** Remove `.<manifest>.<pid>.<n>.tmp` files whose writer is no longer running. */
async function removeStaleTemps(target: string): Promise<void> {
  const prefix = `.${basename(target)}.`;
  let names: string[];
  try {
    names = await readdir(dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const pid = Number(name.slice(prefix.length).split('.')[0]);
    // Ours are never in flight here (we run inside this manifest's queue); a live other pid may be.
    if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) continue;
    await rm(join(dirname(target), name), { force: true }).catch(() => undefined);
  }
}

/** One queue per real manifest file, shared by every store instance in this process. */
const queues = new Map<string, Promise<unknown>>();
/** Manifests whose stale temps this process has already swept. */
const swept = new Set<string>();

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
  /** File mode for a NEW manifest (e.g. `0o600` for private data). An existing file keeps its own. */
  readonly mode?: number;
  /** Extra migrations, keyed by the version they upgrade from; merged over `MANIFEST_MIGRATIONS`. */
  readonly migrations?: Readonly<Record<number, ManifestMigration>>;
  /** Where a throwing `subscribe` listener's error goes. Defaults to `console.error`. */
  readonly onListenerError?: (error: unknown) => void;
}

/** A `GroupStore` over one manifest file. `path` is the manifest path as given, resolved. */
export interface FsGroupStore<P = unknown> extends GroupStore<P> {
  readonly path: string;
}

/** What one read of the manifest yields. */
interface ManifestRead<P> {
  /** The exact text read (`null`: no file), for the before-rename check. */
  readonly text: string | null;
  readonly space: GroupSpace<P>;
  /** Top-level fields this version does not own, kept on the next write. */
  readonly extra: ManifestRecord;
}

/** Create a `GroupStore` persisted as a sidecar manifest. See the module docstring. */
export function createFsGroupStore<P = unknown>(options: FsGroupStoreOptions): FsGroupStore<P> {
  const path = resolve(options.path);
  const io = options.io ?? nodeManifestIO();
  const indent = options.indent ?? 2;
  const migrations = { ...MANIFEST_MIGRATIONS, ...(options.migrations ?? {}) };
  const empty = fromSnapshot<P>(
    { nodes: [], edges: [] },
    {
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    },
  );
  const profile = empty.profile;
  const listeners = createListenerSet<GroupStoreChange>(options.onListenerError);

  const migrate = (where: string, record: ManifestRecord): ManifestRecord => {
    const declared = record.version;
    if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
      throw new ManifestError(where, `"version" must be a non-negative integer, got ${JSON.stringify(declared)}`);
    }
    let version: number = declared;
    if (version > MANIFEST_VERSION) {
      throw new ManifestError(
        where,
        `manifest version ${version} is newer than this package reads (${MANIFEST_VERSION}); upgrade @zodal/groups-store-fs`,
      );
    }
    while (version < MANIFEST_VERSION) {
      const step = migrations[version];
      if (!step) throw new ManifestError(where, `no migration from version ${version} to ${version + 1}`);
      try {
        record = step(record);
      } catch (error) {
        throw new ManifestError(where, `migrating from version ${version} failed: ${(error as Error).message}`, { cause: error });
      }
      if (record.version !== version + 1) {
        throw new ManifestError(where, `the migration from version ${version} produced version ${JSON.stringify(record.version)}, not ${version + 1}`);
      }
      version = record.version as number;
    }
    return record;
  };

  const read = async (target: string): Promise<ManifestRead<P>> => {
    const text = await io.read(target);
    if (text === undefined) return { text: null, space: empty, extra: {} };
    if (text.trim() === '') throw new ManifestError(path, 'the manifest is empty');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ManifestError(path, `the manifest is not valid JSON (${(error as Error).message})`, { cause: error });
    }
    let record = json as ManifestRecord | null;
    if (typeof record !== 'object' || record === null || Array.isArray(record) || record.format !== MANIFEST_FORMAT) {
      throw new ManifestError(path, `not a zodal-groups manifest (expected "format": "${MANIFEST_FORMAT}")`);
    }
    record = migrate(path, record);
    let snapshot;
    try {
      snapshot = parseSnapshot<P>(record);
    } catch (error) {
      throw new ManifestError(path, `malformed manifest: ${(error as Error).message}`, { cause: error });
    }
    const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !OWN_FIELDS.has(key)));
    return { text, space: fromSnapshot(snapshot, { profile }), extra };
  };

  return {
    path,
    profile,
    load: async () => {
      const target = await realTarget(path);
      return enqueue(target, async () => (await read(target)).space);
    },
    apply: async (delta, applyOptions) => {
      const target = await realTarget(path);
      return enqueue(target, async () => {
        if (!swept.has(target)) {
          swept.add(target);
          await removeStaleTemps(target);
        }
        // Read, check the revision, compute the inverse and apply — all inside the queue, against
        // the state actually on disk (an inverse computed from an earlier read undoes the wrong state).
        const before = await read(target);
        const result = commitDelta(before.space, delta, applyOptions);
        if (!result.ok) return result;
        try {
          await io.write(target, serializeManifest(toSnapshot(result.value.space), { indent, extra: before.extra }), {
            ifUnchanged: before.text,
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
          });
        } catch (error) {
          if (!(error instanceof ManifestConflictError)) throw error;
          return {
            ok: false,
            violations: [{ code: 'conflict', actualRevision: before.space.revision, message: error.message }],
          };
        }
        listeners.emit({ delta, inverse: result.value.inverse, revision: result.value.revision });
        return result;
      });
    },
    getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
    subscribe: (listener) => listeners.add(listener),
    dispose: () => listeners.clear(),
  };
}

/**
 * A snapshot as manifest text — what the store writes. Exported for tools that seed or migrate a
 * manifest without going through `apply` (an importer, a test fixture of foreign data). `extra`
 * top-level fields are written too, but never over the ones the format owns.
 */
export function serializeManifest(
  snapshot: GroupSnapshot,
  options: { readonly indent?: number | string; readonly extra?: Readonly<Record<string, unknown>> } = {},
): string {
  const { revision = 0, nodes, edges } = snapshot;
  const manifest = { ...(options.extra ?? {}), format: MANIFEST_FORMAT, version: MANIFEST_VERSION, revision, nodes, edges };
  return `${JSON.stringify(manifest, null, options.indent ?? 2)}\n`;
}
