import { promises as fs } from 'node:fs';

/**
 * Resolves a spec that is referenced by a link but lives outside the scanned tree.
 * Returns the reachable absolute path (or content source) or null when unresolvable.
 */
export interface ExternalResolver {
  /** Local absolute path to the spec, or null if it cannot be resolved. */
  resolveLocal(absPath: string): Promise<boolean>;
  /** Reads content of a URL spec; null if unreachable. */
  fetchUrl(url: string): Promise<string | null>;
}

export const defaultResolver: ExternalResolver = {
  async resolveLocal(absPath) {
    try {
      const st = await fs.stat(absPath);
      return st.isFile();
    } catch {
      return false;
    }
  },
  async fetchUrl(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  },
};
