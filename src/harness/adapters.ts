import { spawn } from 'node:child_process';

export interface HarnessRunOptions {
  /** Working directory: the project root, so the harness can read the whole repo. */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface HarnessRunResult {
  exitCode: number;
  output: string;
}

/** Abstract coding harness. Implementations edit files in place inside `cwd`. */
export interface CodingHarness {
  readonly name: string;
  run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult>;
}

/**
 * Test harness: applies a deterministic function to the filesystem instead of calling an AI.
 * `edit` receives the cwd and can write/delete any file it wants (useful to test enforcement).
 */
export class MockHarness implements CodingHarness {
  readonly name = 'mock';
  readonly prompts: string[] = [];

  constructor(private readonly edit: (cwd: string) => Promise<void> | void) {}

  async run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    this.prompts.push(prompt);
    await this.edit(opts.cwd);
    opts.onLog?.('[mock] edits applied');
    return { exitCode: 0, output: '[mock] edits applied' };
  }
}

/**
 * Harness a comando configurabile: l'utente scrive il comando che lancia il proprio harness.
 * Il prompt sostituisce il segnaposto `{prompt}`; se manca, il prompt va su stdin.
 * Esempi:
 *   docker compose -f /path/docker-compose.yml exec -T hermes-agent hermes chat -Q -q {prompt}
 *   claude -p {prompt}
 *   copilot -p {prompt}
 * Il comando viene diviso come una shell minimale (apici e virgolette ammessi), ma eseguito
 * senza shell: nessuna espansione di variabili, nessun pipe. Il prompt è un singolo argomento.
 */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(cur);
        cur = '';
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (quote) throw new Error('comando harness: virgolette non chiuse');
  if (hasToken) out.push(cur);
  return out;
}

export interface CommandHarnessOptions {
  /** Nome leggibile mostrato in UI/log. */
  name?: string;
  /** Comando completo, es. `claude -p {prompt}`. */
  command: string;
}

export class CommandHarness implements CodingHarness {
  readonly name: string;

  constructor(private readonly opts: CommandHarnessOptions) {
    this.name = opts.name ?? 'command';
    const tokens = parseCommandLine(opts.command);
    if (tokens.length === 0) throw new Error('comando harness vuoto');
  }

  /** Argomenti finali e se il prompt va su stdin (nessun {prompt} nel comando). */
  buildInvocation(prompt: string): { cmd: string; args: string[]; stdin: string } {
    const tokens = parseCommandLine(this.opts.command);
    const hasPlaceholder = tokens.some((t) => t.includes('{prompt}'));
    const args = hasPlaceholder ? tokens.map((t) => t.split('{prompt}').join(prompt)) : tokens.slice(1);
    return { cmd: tokens[0]!, args: hasPlaceholder ? args.slice(1) : args, stdin: hasPlaceholder ? '' : prompt };
  }

  run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    const { cmd, args, stdin } = this.buildInvocation(prompt);
    return runProcess(cmd, args, stdin, opts);
  }
}

/** Esecuzione comune: stdout/stderr raccolti, timeout, abort. Nessuna shell. */
function runProcess(cmd: string, args: string[], stdin: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal });
    let output = '';
    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8');
      output += text;
      for (const line of text.split('\n')) if (line) opts.onLog?.(line);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : undefined;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, output });
    });
    child.stdin.end(stdin);
  });
}

/**
 * Generic CLI harness: runs `command args...` in cwd and writes the prompt to stdin.
 * Agnostic: any CLI that reads a prompt from stdin and edits files in cwd can be plugged in
 * (GitHub Copilot CLI will be configured through this adapter later).
 */
export class CliHarness implements CodingHarness {
  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[] = [],
  ) {}

  run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { cwd: opts.cwd, signal: opts.signal });
      let output = '';
      const onChunk = (buf: Buffer) => {
        const text = buf.toString('utf8');
        output += text;
        for (const line of text.split('\n')) if (line) opts.onLog?.(line);
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);

      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
        : undefined;
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code ?? -1, output });
      });
      child.stdin.end(prompt);
    });
  }
}
