/**
 * Real processes writing one manifest. Without a lock held from read to rename, the re-read-before-
 * rename check leaves a window (~270 µs median) in which two processes both "win": 4 processes ×
 * 150 writes lost 53 writes in review. With the lock, every write lands.
 *
 * Runs the BUILT package (dist/) in child processes; skipped if it has not been built.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const DIST = resolve(__dirname, '..', 'dist', 'index.js');
const WORKERS = 4;
const WRITES = 100;

const WORKER = `
const [, , moduleUrl, path, worker, writes] = process.argv;
const { createFsGroupStore } = await import(moduleUrl);
const store = createFsGroupStore({ path });
const ok = [];
const refused = [];
for (let j = 0; j < Number(writes); j++) {
  const id = 'w' + worker + '>' + j;
  const r = await store.apply({ added: [{ id, parent: 'w' + worker, child: 'item-' + worker + '-' + j, kind: 'contains' }] });
  (r.ok ? ok : refused).push(r.ok ? id : r.violations.map((v) => v.code).join(','));
}
process.stdout.write(JSON.stringify({ ok, refused }));
`;

describe.skipIf(!existsSync(DIST))('several processes writing one manifest', () => {
  it(`${WORKERS} processes × ${WRITES} writes: every write lands, none is refused`, { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'groups-store-fs-procs-'));
    try {
      const script = join(dir, 'worker.mjs');
      await writeFile(script, WORKER);
      const path = join(dir, 'groups.json');
      const outputs = await Promise.all(
        Array.from({ length: WORKERS }, (_, w) =>
          run(process.execPath, [script, pathToFileURL(DIST).href, path, String(w), String(WRITES)], { maxBuffer: 1 << 24 }),
        ),
      );
      const reports = outputs.map((o) => JSON.parse(o.stdout) as { ok: string[]; refused: string[] });
      const ok = reports.flatMap((r) => r.ok);
      const onDisk = new Set((JSON.parse(await readFile(path, 'utf8')).edges as { id: string }[]).map((e) => e.id));
      const lost = ok.filter((id) => !onDisk.has(id));
      expect(lost, `${lost.length} acknowledged writes are not on disk`).toEqual([]);
      expect(reports.flatMap((r) => r.refused)).toEqual([]);
      expect(onDisk.size).toBe(WORKERS * WRITES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
