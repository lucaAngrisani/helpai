import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dependencyOrder, type ReadSpec } from './analyze.js';
import { isSpecFileName } from './scanner.js';
import { toPosix } from './snapshot.js';
import type { SpecGraph } from './types.js';

export interface FolderFile {
  name: string;
  sha256: string;
  /** Text content, or null when the file is binary. */
  content: string | null;
}

export interface InheritedSpec {
  /** Absolute path or original URL. */
  location: string;
  content: string;
  sha256: string;
}

/** Everything the harness needs for one .helpai.md, bounded to its own folder. */
export interface SpecContext {
  rootPath: string;
  specPath: string;
  specRel: string;
  folderPath: string;
  folderRel: string;
  specContent: string;
  specSha256: string;
  /** Upstream specs in topological order (bases first). */
  inherited: InheritedSpec[];
  /** Direct files of the folder only, excluding .helpai.md files. */
  folderFiles: FolderFile[];
  /** Immediate subdirectories, which are excluded from the perimeter. */
  ignoredSubdirs: string[];
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export async function buildContext(
  rootPath: string,
  graph: SpecGraph,
  specPath: string,
  readSpec: ReadSpec,
): Promise<SpecContext> {
  const root = path.resolve(rootPath);
  const specContent = await readSpec(specPath);
  if (specContent === null) throw new Error(`Spec non leggibile: ${specPath}`);

  const inherited: InheritedSpec[] = [];
  for (const location of dependencyOrder(graph, specPath)) {
    const content = await readSpec(location);
    if (content === null) throw new Error(`Spec ereditata non risolvibile: ${location}`);
    inherited.push({ location, content, sha256: sha256(content) });
  }

  const folderPath = path.dirname(specPath);
  const folderRel = toPosix(path.relative(root, folderPath)) || '.';
  const folderFiles: FolderFile[] = [];
  const ignoredSubdirs: string[] = [];
  for (const entry of (await fs.readdir(folderPath, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      ignoredSubdirs.push(entry.name);
      continue;
    }
    if (!entry.isFile() || isSpecFileName(entry.name)) continue;
    const buf = await fs.readFile(path.join(folderPath, entry.name));
    const isBinary = buf.includes(0);
    folderFiles.push({
      name: entry.name,
      sha256: sha256(buf),
      content: isBinary ? null : buf.toString('utf8'),
    });
  }

  return {
    rootPath: root,
    specPath,
    specRel: toPosix(path.relative(root, specPath)),
    folderPath,
    folderRel,
    specContent,
    specSha256: sha256(specContent),
    inherited,
    folderFiles,
    ignoredSubdirs,
  };
}
