import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server/index.js';
import { MockHarness } from '../src/harness/adapters.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'helpai-m3-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const CARD = 'components/card/card.helpai.md';
const base = {
  'component-base.helpai.md': '# Base',
  [CARD]: '# Card\n[Base](../../component-base.helpai.md)',
  'components/card/index.ts': 'v1\n',
};

let app: FastifyInstance | undefined;
let cfgDir: string;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function newConfigFile(verified = true): string {
  cfgDir = mkdtempSync(path.join(os.tmpdir(), 'helpai-cfg-'));
  const file = path.join(cfgDir, 'config.json');
  writeFileSync(file, JSON.stringify({ rootPath: null, harnessCommand: null, harnessTestedOk: verified }));
  return file;
}

async function server(harness = new MockHarness(() => {}), configFile = newConfigFile()) {
  app = await buildServer({ configFile, harness });
  return app;
}

describe('gate Spec->Code sull\'harness Hermes', () => {
  it('align è bloccato (409) finché il test dell\'harness non passa', async () => {
    const a = await server(new MockHarness(() => {}), newConfigFile(false));
    const root = mkdtempSync(path.join(os.tmpdir(), 'helpai-gate-'));
    expect((await configure(a, root)).statusCode).toBe(200);
    const res = await a.inject({ method: 'POST', url: '/api/specs/x/align', payload: { mode: 'yolo' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/harness non verificato/);
  });

  it('PUT del comando azzera il test: va ripetuto prima di allineare', async () => {
    const a = await server(new MockHarness(() => {}), newConfigFile(true));
    const res = await a.inject({ method: 'PUT', url: '/api/harness', payload: { command: 'claude -p {prompt}' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ harnessCommand: 'claude -p {prompt}', harnessTestedOk: false });
  });

  it('comando vuoto è rifiutato (400)', async () => {
    const a = await server();
    const res = await a.inject({ method: 'PUT', url: '/api/harness', payload: { command: '   ' } });
    expect(res.statusCode).toBe(400);
  });

  it('virgolette non chiuse sono rifiutate (400)', async () => {
    const a = await server();
    const res = await a.inject({ method: 'PUT', url: '/api/harness', payload: { command: 'claude -p "{prompt}' } });
    expect(res.statusCode).toBe(400);
  });
});

async function configure(a: FastifyInstance, rootPath: string) {
  return a.inject({ method: 'PUT', url: '/api/config', payload: { rootPath } });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('configurazione rootPath dalla Web UI', () => {
  it('senza rootPath gli endpoint di progetto rispondono 409', async () => {
    const a = await server();
    expect((await a.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({ rootPath: null, configured: false });
    expect((await a.inject({ method: 'GET', url: '/api/project' })).statusCode).toBe(409);
  });

  it('PUT /api/config accetta solo percorsi assoluti esistenti', async () => {
    const a = await server();
    expect((await configure(a, 'relativo/path')).statusCode).toBe(400);
    expect((await configure(a, '/percorso/che/non/esiste/xyz')).statusCode).toBe(400);
    expect((await configure(a, '')).statusCode).toBe(400);
  });

  it('il rootPath impostato persiste al riavvio del server', async () => {
    const root = fixture(base);
    const cfg = newConfigFile();
    const a1 = await server(undefined, cfg);
    expect((await configure(a1, root)).statusCode).toBe(200);
    await a1.close();

    const a2 = await server(undefined, cfg);
    const body = (await a2.inject({ method: 'GET', url: '/api/config' })).json();
    expect(body.rootPath).toBe(root);
    expect((await a2.inject({ method: 'GET', url: '/api/project' })).statusCode).toBe(200);
  });

  it('il rootPath può essere cambiato dopo la configurazione iniziale', async () => {
    const r1 = fixture(base);
    const r2 = fixture({ 'solo.helpai.md': '# Solo' });
    const a = await server();
    await configure(a, r1);
    expect((await a.inject({ method: 'GET', url: '/api/project' })).json().counts.total).toBe(2);
    expect((await configure(a, r2)).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/project' })).json().counts.total).toBe(1);
  });

  it('il cambio di rootPath è rifiutato mentre un run è attivo', async () => {
    const r1 = fixture(base);
    const r2 = fixture(base);
    const harness = new MockHarness(() => new Promise((r) => setTimeout(r, 300)));
    const a = await server(harness);
    await configure(a, r1);
    await a.inject({ method: 'POST', url: `/api/specs/${encodeURIComponent(CARD)}/align`, payload: { mode: 'yolo' } });
    const res = await configure(a, r2);
    expect(res.statusCode).toBe(409);
  });
});

describe('API /api/project', () => {
  it('restituisce nodi, archi, contatori e stato never', async () => {
    const a = await server();
    await configure(a, fixture(base));
    const body = (await a.inject({ method: 'GET', url: '/api/project' })).json();
    expect(body.counts.total).toBe(2);
    expect(body.edges).toEqual([{ from: 'component-base.helpai.md', to: CARD }]);
    expect(body.nodes.find((n: { id: string }) => n.id === CARD).status).toBe('never');
    expect(body.errors).toEqual([]);
  });

  it('segnala errori di validazione', async () => {
    const a = await server();
    await configure(a, fixture({ ...base, 'components/card/dup.helpai.md': '#' }));
    const body = (await a.inject({ method: 'GET', url: '/api/project' })).json();
    expect(body.errors.map((e: { code: string }) => e.code)).toContain('MULTIPLE_SPEC_FILES_IN_FOLDER');
  });
});

describe('API /api/specs/:id', () => {
  it('GET dettaglio, 404 per spec inesistente', async () => {
    const a = await server();
    await configure(a, fixture(base));
    const ok = await a.inject({ method: 'GET', url: `/api/specs/${encodeURIComponent(CARD)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().upstream).toEqual(['component-base.helpai.md']);
    expect(ok.json().folderFiles).toEqual(['index.ts']);
    expect((await a.inject({ method: 'GET', url: '/api/specs/nope.helpai.md' })).statusCode).toBe(404);
  });

  it('PUT salva il contenuto della spec', async () => {
    const root = fixture(base);
    const a = await server();
    await configure(a, root);
    const res = await a.inject({ method: 'PUT', url: `/api/specs/${encodeURIComponent(CARD)}`, payload: { content: '# Nuova' } });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(path.join(root, CARD), 'utf8')).toBe('# Nuova');
  });

  it('reverse-align senza harness verificato risponde 409', async () => {
    const a = await server(new MockHarness(() => {}), newConfigFile(false));
    await configure(a, fixture(base));
    const res = await a.inject({ method: 'POST', url: `/api/specs/${encodeURIComponent(CARD)}/reverse-align` });
    expect(res.statusCode).toBe(409);
  });
});

describe('API align, runs, decisioni CTRL', () => {
  it('YOLO: avvia il run, lo completa e aggiorna lo storico', async () => {
    const root = fixture(base);
    const harness = new MockHarness((cwd) => writeFileSync(path.join(cwd, 'components/card/index.ts'), 'v2\n'));
    const a = await server(harness);
    await configure(a, root);
    const start = await a.inject({ method: 'POST', url: `/api/specs/${encodeURIComponent(CARD)}/align`, payload: { mode: 'yolo' } });
    expect(start.statusCode).toBe(202);
    const runId = start.json().runId;
    const done = await waitFor(async () => {
      const r = (await a.inject({ method: 'GET', url: '/api/runs' })).json().runs.find((x: { id: string }) => x.id === runId);
      return r && (r.status === 'done' || r.status === 'failed') ? r : undefined;
    });
    expect(done.status).toBe('done');
    expect(done.result.applied.map((c: { path: string }) => c.path)).toEqual(['components/card/index.ts']);
    expect(readFileSync(path.join(root, 'components/card/index.ts'), 'utf8')).toBe('v2\n');
    const hist = (await a.inject({ method: 'GET', url: `/api/specs/${encodeURIComponent(CARD)}/history` })).json();
    expect(hist.history).toHaveLength(1);
  });

  it('CTRL: attende la decisione via API e ripristina i file rifiutati', async () => {
    const root = fixture(base);
    const harness = new MockHarness((cwd) => writeFileSync(path.join(cwd, 'components/card/index.ts'), 'v2\n'));
    const a = await server(harness);
    await configure(a, root);
    const runId = (await a.inject({ method: 'POST', url: `/api/specs/${encodeURIComponent(CARD)}/align`, payload: { mode: 'ctrl' } })).json().runId;
    await waitFor(async () => {
      const r = (await a.inject({ method: 'GET', url: '/api/runs' })).json().runs.find((x: { id: string }) => x.id === runId);
      return r?.status === 'awaiting-approval' ? r : undefined;
    });
    expect((await a.inject({ method: 'POST', url: `/api/runs/${runId}/decision`, payload: { keep: false } })).statusCode).toBe(200);
    const done = await waitFor(async () => {
      const r = (await a.inject({ method: 'GET', url: '/api/runs' })).json().runs.find((x: { id: string }) => x.id === runId);
      return r?.status === 'done' ? r : undefined;
    });
    expect(done.result.reverted.map((x: { reason: string }) => x.reason)).toEqual(['rejected']);
    expect(readFileSync(path.join(root, 'components/card/index.ts'), 'utf8')).toBe('v1\n');
  });

  it('decisione senza run in attesa risponde 409', async () => {
    const a = await server();
    await configure(a, fixture(base));
    expect((await a.inject({ method: 'POST', url: '/api/runs/inesistente/decision', payload: { keep: true } })).statusCode).toBe(409);
  });

  it('align su spec con errori fallisce con messaggio chiaro', async () => {
    const a = await server();
    await configure(a, fixture({ ...base, 'components/card/dup.helpai.md': '#' }));
    const runId = (await a.inject({ method: 'POST', url: `/api/specs/${encodeURIComponent(CARD)}/align`, payload: { mode: 'yolo' } })).json().runId;
    const failed = await waitFor(async () => {
      const r = (await a.inject({ method: 'GET', url: '/api/runs' })).json().runs.find((x: { id: string }) => x.id === runId);
      return r?.status === 'failed' ? r : undefined;
    });
    expect(failed.error).toContain('MULTIPLE_SPEC_FILES_IN_FOLDER');
  });
});
