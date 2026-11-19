import path from 'node:path';
import { SPEC_SUFFIX } from './types.js';

export interface SpecLink {
  /** Raw target as written in the Markdown link, e.g. "../component-base.helpai.md". */
  raw: string;
  /** Link target without anchor/query. */
  target: string;
  isUrl: boolean;
}

const LINK_RE = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Strips anchors (#...) and query strings (?...) from a link target. */
function stripFragment(target: string): string {
  return target.replace(/[?#].*$/, '');
}

function isExternalUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * Extracts Markdown links whose target points to a .helpai.md file.
 * Works for both relative paths and http(s) URLs. Code fences are ignored.
 */
export function extractSpecLinks(markdown: string): SpecLink[] {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
  const links: SpecLink[] = [];
  const seen = new Set<string>();
  for (const match of withoutFences.matchAll(LINK_RE)) {
    const raw = match[2] ?? '';
    const target = stripFragment(raw);
    if (!target.endsWith(SPEC_SUFFIX)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({ raw, target, isUrl: isExternalUrl(target) });
  }
  return links;
}

/** Resolves a local link relative to the directory of the spec that contains it. */
export function resolveLocalLink(specPath: string, link: SpecLink): string {
  return path.resolve(path.dirname(specPath), link.target);
}
