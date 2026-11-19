import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanProject, type ScanOptions } from './scanner.js';
import { extractSpecLinks, resolveLocalLink } from './parser.js';
import { defaultResolver, type ExternalResolver } from './resolver.js';
import type { AnalysisResult, SpecGraph, SpecNode, ValidationError } from './types.js';

export interface AnalyzeOptions extends ScanOptions {
  resolver?: ExternalResolver;
  /** Optional content loader used for parsing; defaults to fs/fetch. Useful for tests. */
  readSpec?: (specPath: string) => Promise<string | null>;
}

/**
 * Full deterministic analysis: scan -> validate folder rule -> build spec graph
 * (resolving every link, local or reachable URL) -> detect cycles.
 * Unresolvable links are reported as BROKEN_SPEC_LINK.
 */
export async function analyzeProject(rootPath: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const resolver = opts.resolver ?? defaultResolver;
  const readSpec = opts.readSpec ?? defaultReadSpec(resolver);
  const scan = await scanProject(rootPath, opts);
  const errors: ValidationError[] = [];
  const nodes = new Map<string, SpecNode>();

  // Rule 2.1: at most one spec per folder.
  for (const [folder, files] of scan.specsByFolder) {
    if (files.length > 1) {
      errors.push({
        code: 'MULTIPLE_SPEC_FILES_IN_FOLDER',
        message: `La cartella ${folder} contiene ${files.length} file .helpai.md`,
        paths: files,
      });
    }
  }

  // Seed with every scanned spec, then follow links transitively.
  const queue: Array<{ specPath: string; inRoot: boolean }> = scan.specFiles.map((p) => ({
    specPath: p,
    inRoot: true,
  }));
  const brokenSeen = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (nodes.has(item.specPath)) continue;

    const content = await readSpec(item.specPath);
    const links: string[] = [];
    const node: SpecNode = {
      specPath: item.specPath,
      folderPath: path.dirname(item.specPath),
      inRoot: item.inRoot,
      links,
    };
    nodes.set(item.specPath, node);
    if (content === null) continue; // Spec itself unreachable: reported below as broken link by referrer.

    for (const link of extractSpecLinks(content)) {
      const target = link.isUrl ? link.target : resolveLocalLink(item.specPath, link);
      const key = link.isUrl ? link.target : target;

      const ok = link.isUrl
        ? (await readSpec(target)) !== null
        : await resolver.resolveLocal(target);

      if (!ok) {
        if (!brokenSeen.has(`${item.specPath}|${key}`)) {
          brokenSeen.add(`${item.specPath}|${key}`);
          errors.push({
            code: 'BROKEN_SPEC_LINK',
            message: `Link non risolvibile in ${item.specPath}: ${link.raw}`,
            paths: [item.specPath, key],
          });
        }
        continue;
      }
      links.push(key);
      if (!nodes.has(key)) {
        queue.push({ specPath: key, inRoot: isInside(scan.rootPath, key) });
      }
    }
  }

  const graph = buildGraph(scan.rootPath, nodes);
  errors.push(...detectCycles(graph));

  const specs = [...nodes.values()].filter((n) => n.inRoot).sort((a, b) => a.specPath.localeCompare(b.specPath));
  return { rootPath: scan.rootPath, specs, graph, errors };
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export type ReadSpec = (specPath: string) => Promise<string | null>;

export function defaultReadSpec(resolver: ExternalResolver): ReadSpec {
  return async (p: string): Promise<string | null> => {
    if (/^https?:\/\//i.test(p)) return resolver.fetchUrl(p);
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  };
}

export function buildGraph(rootPath: string, nodes: Map<string, SpecNode>): SpecGraph {
  const down = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    for (const up of node.links) {
      if (!down.has(up)) down.set(up, new Set());
      down.get(up)!.add(node.specPath);
    }
  }
  return {
    rootPath,
    nodes,
    upstream: (p) => [...(nodes.get(p)?.links ?? [])],
    downstream: (p) => [...(down.get(p) ?? [])].sort(),
  };
}

/** DFS with colouring; reports each distinct cycle once as CIRCULAR_SPEC_DEPENDENCY. */
export function detectCycles(graph: SpecGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const reported = new Set<string>();

  function visit(p: string): void {
    state.set(p, 'visiting');
    stack.push(p);
    for (const next of graph.upstream(p)) {
      const s = state.get(next);
      if (s === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({
            code: 'CIRCULAR_SPEC_DEPENDENCY',
            message: `Dipendenza circolare: ${cycle.join(' -> ')}`,
            paths: cycle,
          });
        }
      } else if (s === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(p, 'done');
  }

  for (const p of graph.nodes.keys()) if (!state.has(p)) visit(p);
  return errors;
}

/**
 * Returns the transitive upstream specs of `specPath` in topological order
 * (bases first, `specPath` excluded). Throws if a cycle is reachable.
 */
export function dependencyOrder(graph: SpecGraph, specPath: string): string[] {
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  function visit(p: string): void {
    if (state.get(p) === 'done') return;
    if (state.get(p) === 'visiting') throw new Error(`Dipendenza circolare su ${p}`);
    state.set(p, 'visiting');
    for (const up of graph.upstream(p)) visit(up);
    state.set(p, 'done');
    if (p !== specPath) out.push(p);
  }
  visit(specPath);
  return out;
}
