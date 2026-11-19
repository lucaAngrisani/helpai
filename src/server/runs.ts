import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChangeDecision, RunMode, RunResult } from '../core/runner.js';

export type RunStatus = 'running' | 'awaiting-approval' | 'done' | 'failed';

export interface RunRecord {
  id: string;
  specRel: string;
  mode: RunMode;
  status: RunStatus;
  logs: string[];
  pending?: ChangeDecision;
  result?: RunResult;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * In-memory registry of alignment runs. Emits 'update' for SSE subscribers.
 * CTRL approvals are resolved through `answer(runId, decision)`.
 */
export class RunRegistry extends EventEmitter {
  private runs = new Map<string, RunRecord>();
  private waiters = new Map<string, (ok: boolean) => void>();

  create(specRel: string, mode: RunMode): RunRecord {
    const rec: RunRecord = {
      id: randomUUID(),
      specRel,
      mode,
      status: 'running',
      logs: [],
      startedAt: new Date().toISOString(),
    };
    this.runs.set(rec.id, rec);
    this.touch(rec);
    return rec;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  log(id: string, line: string): void {
    const rec = this.runs.get(id);
    if (!rec) return;
    rec.logs.push(line);
    this.touch(rec);
  }

  /** Waits for a CTRL decision for one file. Resolves true to keep the change. */
  requestApproval(id: string, decision: ChangeDecision): Promise<boolean> {
    const rec = this.runs.get(id);
    if (!rec) return Promise.resolve(false);
    rec.status = 'awaiting-approval';
    rec.pending = decision;
    this.touch(rec);
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }

  answer(id: string, keep: boolean): boolean {
    const rec = this.runs.get(id);
    const waiter = this.waiters.get(id);
    if (!rec || !waiter || rec.status !== 'awaiting-approval') return false;
    this.waiters.delete(id);
    rec.pending = undefined;
    rec.status = 'running';
    this.touch(rec);
    waiter(keep);
    return true;
  }

  finish(id: string, result: RunResult): void {
    const rec = this.runs.get(id);
    if (!rec) return;
    rec.status = 'done';
    rec.result = result;
    rec.finishedAt = new Date().toISOString();
    this.touch(rec);
  }

  fail(id: string, error: string): void {
    const rec = this.runs.get(id);
    if (!rec) return;
    rec.status = 'failed';
    rec.error = error;
    rec.finishedAt = new Date().toISOString();
    this.touch(rec);
  }

  private touch(rec: RunRecord): void {
    this.emit('update', rec);
  }
}
