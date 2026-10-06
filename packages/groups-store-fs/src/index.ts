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
 * - **other processes are excluded** — every `apply` holds an exclusive `<manifest>.lock` (created
 *   with `wx`, holding pid + timestamp) from its read to its rename. A lock whose process is dead,
 *   or older than `staleLockMs` (30 s), is broken safely; a live holder is waited for with backoff
 *   until `lockTimeoutMs` (10 s), then `ManifestLockError`. Reads take no lock (renames are atomic).
 *   On top of that, the manifest is re-read just before the rename, and a change since this write's
 *   read (a hand edit, a writer that ignores the lock) is returned as `conflict`, not overwritten —
 *   but that check alone leaves a window of ~270 µs median between check and rename, which lost
 *   writes across processes before the lock existed. Local filesystems: a lock's pid cannot be
 *   checked across machines on a network share.
 * - **the file mode is kept** (a `0600` manifest stays `0600`; `mode` sets it for a new one);
 * - **stale temp files** a dead process left behind are removed (once per manifest per process);
 * - **parent directory created** on first write;
 * - **a corrupt manifest is an error, never an empty space** — invalid JSON, an empty file, a file
 *   that is not a zodal-groups manifest, a newer format, a version with no migration, or a
 *   malformed node/edge all reject with a `ManifestError` naming the file, and nothing is written
 *   over it;
 * - **forward-compatible** — top-level fields this version does not know are kept on every write,
 *   and older versions are upgraded through a `migrations` map keyed by version;
 * - **one history per file** — the manifest carries an `epoch` minted when it is created, so an
 *   `(expectedEpoch, expectedRevision)` from a deleted-and-re-created manifest is refused even when
 *   the revision number happens to match.
 *
 * Each `load`/`apply` re-reads the manifest, so edits made between operations (by hand, by another
 * tool) are seen. Data on disk is not validated against the profile on read (D8: enforce on write,
 * never trust on read); `validateProfile` / `inferProfile` from groups-core report its shape.
 *
 * @see `@zodal/groups-core` `GroupStore` for the contract; this adapter runs its test-kit.
 */

import { link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CLIENT_SIDE_CAPABILITIES,
  commitDelta,
  createListenerSet,
  fromSnapshot,
  newEpoch,
  parseSnapshot,
  toSnapshot,
  type GroupProfile,
  type GroupSnapshot,
  type GroupSpace,
  type GroupStore,
  type GroupStoreChange,
  type EdgeDelta,
  type ProfileName,
  type Result,
  type StoreApplied,
  type StoreApplyOptions,
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
const OWN_FIELDS = new Set(['format', 'version', 'epoch', 'revision', 'nodes', 'edges']);

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

/** Could not take the manifest's lock in time: another writer holds it (and is alive). */
export class ManifestLockError extends Error {
  readonly path: string;
  constructor(path: string, holder: string, timeoutMs: number) {
    super(
      `${path}: could not take ${path}.lock within ${timeoutMs} ms — held by ${holder}. Nothing was written. ` +
        'If no process is writing this manifest, delete the lock file.',
    );
    this.name = 'ManifestLockError';
    this.path = path;
  }
}

/** File access, injectable for tests and non-default hosts. */
export interface ManifestIO {
  /** The file's text, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Replace the file's contents atomically, creating its parent directory if needed. */
  write(path: string, text: string, options?: ManifestWriteOptions): Promise<void>;
  /**
   * Take an exclusive, cross-process lock on the manifest; resolve to its release. The store holds
   * it from the read to the rename of every `apply`. Optional: without it, writers in other
   * processes are only *detected* (best effort), not excluded.
   */
  lock?(path: string): Promise<() => Promise<void>>;
}

export interface NodeManifestIOOptions {
  /** Give up taking the lock after this long (`ManifestLockError`). Default 10 s. */
  readonly lockTimeoutMs?: number;
  /** A lock older than this is broken even if its process is alive (it hung). Default 30 s. */
  readonly staleLockMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
let lockCounter = 0;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Who holds a lock, as read from its file — or `undefined` if the lock is gone. */
async function lockHolder(lockPath: string): Promise<{ text: string; pid?: number; at: number } | undefined> {
  const text = await readText(lockPath);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; at?: unknown };
    if (Number.isInteger(parsed.pid) && typeof parsed.at === 'number') return { text, pid: parsed.pid as number, at: parsed.at };
  } catch {
    /* half-written, or not ours: judge it by its age */
  }
  try {
    return { text, at: (await stat(lockPath)).mtimeMs };
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Break a stale lock without ever breaking a fresh one: rename it away (atomic — only one breaker
 * wins), then check that what we took is the stale lock we judged; if someone had re-taken it in
 * between, put theirs back (`link` fails if yet another writer already holds the name).
 */
async function breakLock(lockPath: string, stale: { text: string }): Promise<void> {
  const aside = `${lockPath}.stale.${process.pid}.${(lockCounter += 1)}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (errno(error) === 'ENOENT') return; // already released or broken by someone else
    throw error;
  }
  try {
    if ((await readText(aside)) !== stale.text) await link(aside, lockPath).catch(() => undefined);
  } finally {
    await rm(aside, { force: true }).catch(() => undefined);
  }
}

async function acquireLock(path: string, timeoutMs: number, staleMs: number): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: Date.now(), n: (lockCounter += 1), r: Math.random() });
  const deadline = Date.now() + timeoutMs;
  let backoff = 1;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(body, 'utf8');
      } finally {
        await handle.close();
      }
      // Release only OUR lock: if it was broken as stale and re-taken, the file is someone else's.
      return async () => {
        if ((await readText(lockPath)) === body) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
    const holder = await lockHolder(lockPath);
    if (!holder) continue; // released between our attempt and our look: try again at once
    const dead = holder.pid !== undefined && holder.pid !== process.pid && !isAlive(holder.pid);
    if (dead || Date.now() - holder.at > staleMs) {
      await breakLock(lockPath, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holder.pid !== undefined ? `pid ${holder.pid} since ${new Date(holder.at).toISOString()}` : 'an unreadable lock file';
      throw new ManifestLockError(path, who, timeoutMs);
    }
    await sleep(backoff + Math.random() * backoff);
    backoff = Math.min(backoff * 2, 25);
  }
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

/**
 * The default `ManifestIO`: Node fs, with an fsynced temp file renamed over the target, and an
 * exclusive `<manifest>.lock` (pid + timestamp) for cross-process writers. Local filesystems: a
 * lock's pid cannot be checked across machines on a network share.
 */
export function nodeManifestIO(options: NodeManifestIOOptions = {}): ManifestIO {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  return {
    read: readText,
    lock: (path) => acquireLock(path, timeoutMs, staleMs),
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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove temp files this package wrote — exactly `.<manifest>.<pid>.<n>.tmp`, nothing else — whose
 * writer is no longer running. A name that does not match exactly is not ours and is left alone.
 */
async function removeStaleTemps(target: string): Promise<void> {
  const ours = new RegExp(`^\\.${escapeRegExp(basename(target))}\\.(\\d+)\\.(\\d+)\\.tmp$`);
  let names: string[];
  try {
    names = await readdir(dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    const match = ours.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    // Ours are never in flight here (we run inside this manifest's queue); a live other pid may be.
    if (pid !== process.pid && isAlive(pid)) continue;
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
  /** File access. Defaults to `nodeManifestIO({ lockTimeoutMs, staleLockMs })`. */
  readonly io?: ManifestIO;
  /** How long `apply` waits for another process's lock before `ManifestLockError`. Default 10 s. */
  readonly lockTimeoutMs?: number;
  /** A lock older than this is broken even if its holder is alive (it hung). Default 30 s. */
  readonly staleLockMs?: number;
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
  /** The manifest's history id; `undefined` for no file yet (or one written before epochs). */
  readonly epoch: string | undefined;
}

/** Create a `GroupStore` persisted as a sidecar manifest. See the module docstring. */
export function createFsGroupStore<P = unknown>(options: FsGroupStoreOptions): FsGroupStore<P> {
  const path = resolve(options.path);
  const io =
    options.io ??
    nodeManifestIO({
      ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
      ...(options.staleLockMs !== undefined ? { staleLockMs: options.staleLockMs } : {}),
    });
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
    if (text === undefined) return { text: null, space: empty, extra: {}, epoch: undefined };
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
    if (record.epoch !== undefined && (typeof record.epoch !== 'string' || record.epoch === '')) {
      throw new ManifestError(path, `"epoch" must be a non-empty string, got ${JSON.stringify(record.epoch)}`);
    }
    let snapshot;
    try {
      snapshot = parseSnapshot<P>(record);
    } catch (error) {
      throw new ManifestError(path, `malformed manifest: ${(error as Error).message}`, { cause: error });
    }
    const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !OWN_FIELDS.has(key)));
    return { text, space: fromSnapshot(snapshot, { profile }), extra, epoch: record.epoch as string | undefined };
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
        // Other processes: hold the manifest's lock from this read to the rename.
        const release = await io.lock?.(target);
        try {
          return await applyLocked(target, delta, applyOptions);
        } finally {
          await release?.();
        }
      });
    },
    getCapabilities: () => CLIENT_SIDE_CAPABILITIES,
    subscribe: (listener) => listeners.add(listener),
    dispose: () => listeners.clear(),
  };

  async function applyLocked(
    target: string,
    delta: EdgeDelta,
    applyOptions: StoreApplyOptions | undefined,
  ): Promise<Result<StoreApplied<P>>> {
    if (!swept.has(target)) {
      swept.add(target);
      await removeStaleTemps(target);
    }
    // Read, check the revision, compute the inverse and apply — all inside the queue, against
    // the state actually on disk (an inverse computed from an earlier read undoes the wrong state).
    const before = await read(target);
    // A new manifest (or one from before epochs) starts a new history.
    const epoch = before.epoch ?? newEpoch();
    const result = commitDelta(before.space, delta, applyOptions ?? {}, epoch);
    if (!result.ok) return result;
    try {
      await io.write(target, serializeManifest(toSnapshot(result.value.space), { indent, extra: before.extra, epoch }), {
        ifUnchanged: before.text,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
      });
    } catch (error) {
      if (!(error instanceof ManifestConflictError)) throw error;
      // Report where the file actually is now, not the revision we read before the other writer.
      const actual = await read(target).then(
        (now) => now.space.revision,
        () => undefined,
      );
      const expected = applyOptions?.expectedRevision;
      return {
        ok: false,
        violations: [
          {
            code: 'conflict',
            ...(expected !== undefined ? { expectedRevision: expected } : {}),
            ...(actual !== undefined ? { actualRevision: actual } : {}),
            message: error.message,
          },
        ],
      };
    }
    listeners.emit({ delta, inverse: result.value.inverse, revision: result.value.revision, epoch });
    return result;
  }
}

/**
 * A snapshot as manifest text — what the store writes. Exported for tools that seed or migrate a
 * manifest without going through `apply` (an importer, a test fixture of foreign data). `extra`
 * top-level fields are written too, but never over the ones the format owns.
 */
export function serializeManifest(
  snapshot: GroupSnapshot,
  options: {
    readonly indent?: number | string;
    readonly extra?: Readonly<Record<string, unknown>>;
    /** The history id; omit for a seed (the store mints one on its first write). */
    readonly epoch?: string;
  } = {},
): string {
  const { revision = 0, nodes, edges } = snapshot;
  const manifest = {
    ...(options.extra ?? {}),
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
    revision,
    nodes,
    edges,
  };
  return `${JSON.stringify(manifest, null, options.indent ?? 2)}\n`;
}
