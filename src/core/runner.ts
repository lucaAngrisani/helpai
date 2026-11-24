import { promises as fs } from 'node:fs';
import path from 'node:path';
import { analyzeProject, defaultReadSpec, type AnalyzeOptions } from './analyze.js';
import { buildContext, type SpecContext } from './context.js';
import { lineDiff } from './diff.js';
import { computeFingerprint, appendHistory, loadState, saveState, type HistorySnapshot } from './state.js';
import { diffSnapshots, revertChange, snapshotProject, type FileChange, type Snapshot } from './snapshot.js';
import { buildPrompt, buildReversePrompt } from '../harness/prompt.js';
import { parseProposal, validateProposalNames } from './proposal.js';
import type { CodingHarness } from '../harness/adapters.js';
import { defaultResolver } from './resolver.js';
import type { ValidationError } from './types.js';

export type RunMode = 'yolo' | 'ctrl';
export type RunTask = 'spec-to-code' | 'code-to-spec';

export interface ChangeDecision {
  change: FileChange;
  /** Line diff of the file (empty for binary or deleted-then-empty files). */
  diff: string;
}

export interface RunOptions extends AnalyzeOptions {
  /** 'code-to-spec': the harness rewrites only the spec from the code. Default: 'spec-to-code'. */
  task?: RunTask;
  mode: RunMode;
  harness: CodingHarness;
  /** Required in CTRL mode: true keeps the change, false reverts it. */
  approve?: (d: ChangeDecision) => Promise<boolean>;
  onLog?: (line: string) => void;
  timeoutMs?: number;
  /** 'direct': l'harness scrive sul disco. 'files': l'harness risponde con JSON, HelpAI scrive. */
  contract?: 'direct' | 'files';
}

export type RevertReason = 'outside-perimeter' | 'spec-file' | 'rejected';

export interface RunResult {
  specRel: string;
  mode: RunMode;
  applied: FileChange[];
  reverted: { change: FileChange; reason: RevertReason }[];
  harnessExitCode: number;
  historyId: string;
}

export class BlockingValidationError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super(`Allineamento bloccato da ${errors.length} errore/i di validazione`);
  }
}

/**
 * Spec -> Code alignment for one .helpai.md.
 * 1. Blocks on validation errors involving the spec or its dependency subgraph.
 * 2. Builds context: inherited specs (topological) + direct folder files only.
 * 3. Runs the harness and snapshots the whole project before/after.
 * 4. Enforcement, in every mode: changes to .helpai.md files or outside the target
 *    folder are reverted automatically.
 * 5. YOLO keeps in-perimeter changes; CTRL asks `approve` per file and reverts rejections.
 * 6. Saves state (.helpai/state.json) and the last 3 run snapshots (.helpai/history/).
 */
export async function alignSpec(rootPath: string, specRel: string, opts: RunOptions): Promise<RunResult> {
  if (opts.mode === 'ctrl' && !opts.approve) {
    throw new Error('La modalità CTRL richiede la funzione approve');
  }
  const root = path.resolve(rootPath);
  const specPath = path.join(root, ...specRel.split('/'));
  const resolver = opts.resolver ?? defaultResolver;
  const readSpec = opts.readSpec ?? defaultReadSpec(resolver);

  const analysis = await analyzeProject(root, { ...opts, resolver, readSpec });
  const subgraph = new Set([specPath, ...analysis.graph.upstream(specPath)]);
  const blocking = analysis.errors.filter((e) => e.paths.some((p) => subgraph.has(p)));
  if (blocking.length > 0) throw new BlockingValidationError(blocking);

  const ctx: SpecContext = await buildContext(root, analysis.graph, specPath, readSpec);
  const before = await snapshotProject(root, opts.ignoredDirs ?? []);
  opts.onLog?.(`[helpai] harness=${opts.harness.name} mode=${opts.mode} target=${ctx.folderRel}`);

  const run = await opts.harness.run(
    opts.task === 'code-to-spec' ? buildReversePrompt(ctx) : buildPrompt(ctx, opts.contract ?? 'direct'),
    { cwd: root, onLog: opts.onLog, timeoutMs: opts.timeoutMs },
  );
  if (opts.contract === 'files' || opts.task === 'code-to-spec') {
    if (run.exitCode !== 0) throw new Error(`harness terminato con exit ${run.exitCode}: nessuna modifica applicata`);
    const proposed = parseProposal(run.output);
    if (opts.task === 'code-to-spec') {
      // Reverse mode: the only allowed output is the target spec itself.
      const specName = path.basename(ctx.specRel);
      const names = Object.keys(proposed);
      if (names.length !== 1 || names[0] !== specName) {
        throw new Error(`code→spec: il harness deve restituire solo ${specName}`);
      }
    } else {
      validateProposalNames(proposed);
    }
    const folderAbs = ctx.folderRel === '.' ? root : path.join(root, ...ctx.folderRel.split('/'));
    for (const [name, content] of Object.entries(proposed)) {
      await fs.writeFile(path.join(folderAbs, name), content, 'utf8');
    }
    opts.onLog?.(`[helpai] proposta ricevuta: ${Object.keys(proposed).length} file`);
  }
  const after = await snapshotProject(root, opts.ignoredDirs ?? []);
  const changes = diffSnapshots(before, after, ctx.folderRel, ctx.specRel);

  const applied: FileChange[] = [];
  const reverted: RunResult['reverted'] = [];

  for (const change of changes) {
    if (change.isSpec && opts.task !== 'code-to-spec') {
      await revertChange(root, before, change);
      reverted.push({ change, reason: 'spec-file' });
    } else if (!change.inPerimeter) {
      await revertChange(root, before, change);
      reverted.push({ change, reason: 'outside-perimeter' });
    }
  }

  const candidates = changes.filter(
    (c) => c.inPerimeter && (!c.isSpec || opts.task === 'code-to-spec'),
  );
  for (const change of candidates) {
    if (opts.mode === 'yolo') {
      applied.push(change);
      continue;
    }
    if (!opts.approve) throw new Error('La modalità CTRL richiede la funzione approve');
    const ok = await opts.approve({ change, diff: diffFor(before, after, change) });
    if (ok) {
      applied.push(change);
    } else {
      await revertChange(root, before, change);
      reverted.push({ change, reason: 'rejected' });
    }
  }

  // Persist state with the fingerprint of the context as it now is.
  const state = await loadState(root);
  const fresh = await buildContext(root, analysis.graph, specPath, readSpec);
  state.specs[ctx.specRel] = {
    fingerprint: computeFingerprint(fresh),
    lastRun: { at: new Date().toISOString(), mode: opts.mode, applied: applied.length, reverted: reverted.length },
  };
  await saveState(root, state);

  const snap: HistorySnapshot = {
    id: `${Date.now()}`,
    at: new Date().toISOString(),
    mode: opts.mode,
    files: await readFolderTexts(root, ctx.folderRel),
  };
  await appendHistory(root, ctx.specRel, snap);

  return {
    specRel: ctx.specRel,
    mode: opts.mode,
    applied,
    reverted,
    harnessExitCode: run.exitCode,
    historyId: snap.id,
  };
}

function diffFor(before: Snapshot, after: Snapshot, change: FileChange): string {
  const b = before.get(change.path);
  const a = after.get(change.path);
  if ((b && b.includes(0)) || (a && a.includes(0))) return '(file binario)';
  return lineDiff(b ? b.toString('utf8') : '', a ? a.toString('utf8') : '');
}

/** Text content of the direct, non-spec, non-binary files in a folder. */
async function readFolderTexts(root: string, folderRel: string): Promise<Record<string, string>> {
  const dir = folderRel === '.' ? root : path.join(root, ...folderRel.split('/'));
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.helpai.md')) continue;
    const buf = await fs.readFile(path.join(dir, entry.name));
    if (!buf.includes(0)) out[entry.name] = buf.toString('utf8');
  }
  return out;
}
