import { describe, it, expect } from 'vitest';
import { CommandHarness, parseCommandLine } from '../src/harness/adapters.js';

describe('parseCommandLine', () => {
  it('divide per spazi e rispetta le virgolette', () => {
    expect(parseCommandLine('claude -p {prompt}')).toEqual(['claude', '-p', '{prompt}']);
    expect(parseCommandLine('cmd "a b" \'c d\'')).toEqual(['cmd', 'a b', 'c d']);
  });

  it('virgolette non chiuse lanciano errore', () => {
    expect(() => parseCommandLine('cmd "x')).toThrow(/virgolette/);
  });
});

describe('CommandHarness', () => {
  it('sostituisce {prompt} come singolo argomento, senza stdin', () => {
    const h = new CommandHarness({ command: 'claude -p {prompt}' });
    const inv = h.buildInvocation('ciao mondo; rm -rf /');
    expect(inv).toEqual({ cmd: 'claude', args: ['-p', 'ciao mondo; rm -rf /'], stdin: '' });
  });

  it('senza segnaposto il prompt va su stdin', () => {
    const h = new CommandHarness({ command: 'mio-harness --yes' });
    expect(h.buildInvocation('prompt')).toEqual({ cmd: 'mio-harness', args: ['--yes'], stdin: 'prompt' });
  });

  it('il comando docker di Hermes funziona con qualunque compose', () => {
    const h = new CommandHarness({
      command: 'docker compose -f /altro/percorso/compose.yml exec -T hermes-agent hermes chat -Q -q {prompt}',
    });
    const inv = h.buildInvocation('OK');
    expect(inv.cmd).toBe('docker');
    expect(inv.args.slice(0, 3)).toEqual(['compose', '-f', '/altro/percorso/compose.yml']);
    expect(inv.args.at(-1)).toBe('OK');
  });
});
