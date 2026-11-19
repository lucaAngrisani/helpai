import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SpecContext } from './context.js';

export const STATE_DIR = '.helpai';
const STATE_FILE = 'state.json';
const HISTORY_DIR = 'history';
export const HISTORY_LIMIT = 3;

export interface Fingerprint {
  spec: string;
  folder: string;
  inherited: Record<string, string>;
}

export interface SpecState {
  fingerprint: Fingerprint;
  lastRun?: { at: string; mode: string; applied: number; reverted: number };
}

export interface ProjectState {
  version: 1;
  specs: Record<string, SpecState>;
}

export type SpecStatus = 'never' | 'synced' | 'stale' | 'error';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

export function computeFingerprint(ctx: SpecContext): Fingerprint {
  const folder = ctx.folderFiles.map((f) => `${f.name}:${f.sha256}`).join('\n');
  const inherited: Record<string, string> = {};
  for (const i of ctx.inherited) inherited[i.location] = i.sha256;
  return { spec: ctx.specSha256, folder: hash(folder), inherited };
}

export async function loadState(rootPath: string): Promise<ProjectState> {
  try {
    const raw = await fs.readFile(path.join(rootPath, STATE_DIR, STATE_FILE), 'utf8');
    return JSON.parse(raw) as ProjectState;
  } catch {
    return { version: 1, specs: {} };
  }
}

export async function saveState(rootPath: string, state: ProjectState): Promise<void> {
  const dir = path.join(rootPath, STATE_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

/** Compares the recorded fingerprint with the current one. */
export function statusOf(
  state: ProjectState,
  specRel: string,
  current: Fingerprint,
  hasBlockingErrors: boolean,
): SpecStatus {
  if (hasBlockingErrors) return 'error';
  const recorded = state.specs[specRel];
  if (!recorded) return 'never';
  return JSON.stringify(recorded.fingerprint) === JSON.stringify(current) ? 'synced' : 'stale';
}

export interface HistorySnapshot {
  id: string;
  at: string;
  mode: string;
  /** Folder files after the run: name -> text (binary files omitted). */
  files: Record<string, string>;
}

function historyFile(rootPath: string, specRel: string): string {
  const encoded = specRel.replace(/[\\/]/g, '__');
  return path.join(rootPath, STATE_DIR, HISTORY_DIR, `${encoded}.json`);
}

export async function readHistory(rootPath: string, specRel: string): Promise<HistorySnapshot[]> {
  try {
    return JSON.parse(await fs.readFile(historyFile(rootPath, specRel), 'utf8')) as HistorySnapshot[];
  } catch {
    return [];
  }
}

/** Prepends a snapshot (newest first) and keeps only the last `limit` entries. */
export async function appendHistory(
  rootPath: string,
  specRel: string,
  snap: HistorySnapshot,
  limit = HISTORY_LIMIT,
): Promise<void> {
  const list = [snap, ...(await readHistory(rootPath, specRel))].slice(0, limit);
  const file = historyFile(rootPath, specRel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(list, null, 2) + '\n');
}
