import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractSpecLinks, resolveLocalLink } from './parser.js';
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
  /** Files referenced by links from the spec (other folders), read-only context. */
  referenced: ReferencedFile[];
}

export interface ReferencedFile {
  /** Path relative to the project root, posix. */
  rel: string;
  content: string;
}

const MAX_REFERENCED_FILES = 20;
const MAX_REFERENCED_BYTES = 64 * 1024;

/**
 * Files pointed to by the spec's links (`[x](../other/x.helpai.md)`): the spec itself and its
 * direct folder files. Read-only context for the harness, so changes stay minimal.
 */
async function collectReferenced(root: string, specPath: string, specContent: string): Promise<ReferencedFile[]> {
  const out: ReferencedFile[] = [];
  const seen = new Set<string>([specPath]);
  for (const link of extractSpecLinks(specContent)) {
    if (link.isUrl) continue;
    const linked = resolveLocalLink(specPath, link);
    if (seen.has(linked) || (!linked.startsWith(root + path.sep) && linked !== root)) continue;
    seen.add(linked);
    const linkedDir = path.dirname(linked);
    const files: string[] = [linked];
    for (const entry of await fs.readdir(linkedDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && !isSpecFileName(entry.name)) files.push(path.join(linkedDir, entry.name));
    }
    for (const file of files) {
      if (out.length >= MAX_REFERENCED_FILES) return out;
      const buf = await fs.readFile(file).catch(() => null);
      if (!buf || buf.includes(0) || buf.length > MAX_REFERENCED_BYTES) continue;
      out.push({ rel: toPosix(path.relative(root, file)), content: buf.toString('utf8') });
    }
  }
  return out;
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
    referenced: await collectReferenced(root, specPath, specContent),
  };
}
