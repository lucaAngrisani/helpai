import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SPEC_SUFFIX } from './types.js';

/** Directory names never descended into during a scan. */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.helpai',
]);

export interface ScanOptions {
  ignoredDirs?: Iterable<string>;
}

export interface ScanResult {
  rootPath: string;
  /** Absolute paths of every .helpai.md found under rootPath, sorted. */
  specFiles: string[];
  /** Map folder absolute path -> spec files located directly in it (sorted). */
  specsByFolder: Map<string, string[]>;
}

export function isSpecFileName(name: string): boolean {
  // Accetta anche il nome nudo `.helpai.md` (progetto a file singolo).
  return name.endsWith(SPEC_SUFFIX);
}

/** Recursively scans rootPath for .helpai.md files, skipping ignored directories. */
export async function scanProject(rootPath: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const absRoot = path.resolve(rootPath);
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(opts.ignoredDirs ?? [])]);
  const specFiles: string[] = [];
  const specsByFolder = new Map<string, string[]>();

  const stat = await fs.stat(absRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`rootPath non è una directory esistente: ${absRoot}`);
  }

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(full);
      } else if (entry.isFile() && isSpecFileName(entry.name)) {
        specFiles.push(full);
        const list = specsByFolder.get(dir) ?? [];
        list.push(full);
        specsByFolder.set(dir, list);
      }
    }
  }

  await walk(absRoot);
  specFiles.sort();
  return { rootPath: absRoot, specFiles, specsByFolder };
}
