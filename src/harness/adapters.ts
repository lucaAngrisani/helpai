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

export interface HermesHarnessOptions {
  /** Nome del servizio docker compose che esegue Hermes (default: hermes-agent). */
  service?: string;
  /** File docker-compose.yml di Hermes. */
  composeFile: string;
  /** Modello da usare. Vuoto/undefined = default di Hermes (nessun flag -m). */
  model?: string;
}

/**
 * Harness Hermes: lancia `hermes chat -Q -q <prompt>` nel container del servizio Hermes
 * tramite `docker compose exec -T`. Il modello è opzionale: senza valore resta il default.
 * Il comando è eseguito con spawn senza shell: il prompt non viene interpretato.
 */
export class HermesHarness implements CodingHarness {
  readonly name = 'hermes';

  constructor(private readonly opts: HermesHarnessOptions) {}

  buildArgs(prompt: string): string[] {
    const args = ['compose', '-f', this.opts.composeFile, 'exec', '-T', this.opts.service ?? 'hermes-agent', 'hermes', 'chat', '-Q'];
    if (this.opts.model && this.opts.model.trim() !== '') args.push('-m', this.opts.model.trim());
    args.push('-q', prompt);
    return args;
  }

  run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    const [cmd, ...args] = ['docker', ...this.buildArgs(prompt)];
    return runProcess(cmd, args, '', opts);
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
