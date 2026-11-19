import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_IGNORED_DIRS, isSpecFileName } from './scanner.js';

/** Map of posix relative path -> file bytes. */
export type Snapshot = Map<string, Buffer>;

export interface FileChange {
  /** Posix path relative to rootPath. */
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  /** True when the file is a direct child of the target folder. */
  inPerimeter: boolean;
  /** True when the file is a .helpai.md spec (never writable by the harness). */
  isSpec: boolean;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export async function snapshotProject(rootPath: string, ignoredDirs: Iterable<string> = []): Promise<Snapshot> {
  const root = path.resolve(rootPath);
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...ignoredDirs]);
  const snap: Snapshot = new Map();

  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        snap.set(toPosix(path.relative(root, full)), await fs.readFile(full));
      }
    }
  }

  await walk(root);
  return snap;
}

export function diffSnapshots(before: Snapshot, after: Snapshot, targetFolderRel: string, specRel: string): FileChange[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes: FileChange[] = [];
  for (const key of [...keys].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    let kind: FileChange['kind'] | null = null;
    if (b && !a) kind = 'deleted';
    else if (!b && a) kind = 'added';
    else if (b && a && !b.equals(a)) kind = 'modified';
    if (!kind) continue;
    changes.push({
      path: key,
      kind,
      inPerimeter: path.posix.dirname(key) === targetFolderRel,
      isSpec: isSpecFileName(path.posix.basename(key)) || key === specRel,
    });
  }
  return changes;
}

/** Restores a single file to its state in `before` (or removes it if it did not exist). */
export async function revertChange(rootPath: string, before: Snapshot, change: FileChange): Promise<void> {
  const abs = path.join(rootPath, ...change.path.split('/'));
  const original = before.get(change.path);
  if (original) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, original);
  } else {
    await fs.rm(abs, { force: true });
  }
}
