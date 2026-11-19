import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';

/** src/web in sviluppo, dist/../src/web dopo la build: stessa radice di progetto. */
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web');
import { analyzeProject, defaultReadSpec } from '../core/analyze.js';
import { buildContext } from '../core/context.js';
import { alignSpec, BlockingValidationError } from '../core/runner.js';
import { defaultResolver } from '../core/resolver.js';
import { readHistory, loadState, statusOf, computeFingerprint } from '../core/state.js';
import { compareFiles } from '../core/diff.js';
import type { CodingHarness } from '../harness/adapters.js';
import { HermesHarness } from '../harness/adapters.js';
import type { SpecGraph } from '../core/types.js';
import { RunRegistry } from './runs.js';
import { ConfigStore, validateRootPath } from './config.js';

export interface ServerOptions {
  /** File JSON dove viene salvato il rootPath scelto dalla Web UI. */
  configFile: string;
  harness: CodingHarness;
  logger?: boolean;
  timeoutMs?: number;
}

/** Id stabile di un nodo: percorso della spec relativo a rootPath, stile posix. */
const fromId = (id: string) => id.split('/').join(path.sep);

/**
 * API HTTP. Il progetto target NON è un parametro di avvio: si imposta con PUT /api/config
 * (dalla Web UI), viene salvato in configFile e può essere cambiato in seguito.
 * Gli endpoint di progetto rispondono 409 finché rootPath non è configurato.
 */
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/', index: ['index.html'] });
  const runs = new RunRegistry();
  const readSpec = defaultReadSpec(defaultResolver);
  const store = new ConfigStore(opts.configFile);
  let root: string | null = (await store.load()).rootPath;

  const rel = (abs: string) => path.relative(root ?? '', abs).split(path.sep).join('/');
  const notConfigured = (reply: FastifyReply) =>
    reply.code(409).send({ error: 'rootPath non configurato: impostalo da PUT /api/config' });
  const hasActiveRuns = () => runs.list().some((r) => r.status === 'running' || r.status === 'awaiting-approval');

  async function nodeView(
    specRel: string,
    graph: SpecGraph,
    errors: { paths: string[] }[],
    state: Awaited<ReturnType<typeof loadState>>,
  ) {
    const specPath = path.join(root!, ...specRel.split('/'));
    const ctx = await buildContext(root!, graph, specPath, readSpec);
    const blocking = errors.some((e) => e.paths.includes(specPath));
    return {
      id: specRel,
      specPath: specRel,
      folderPath: ctx.folderRel,
      status: statusOf(state, specRel, computeFingerprint(ctx), blocking),
      upstream: graph.upstream(specPath).map(rel),
      downstream: graph.downstream(specPath).map(rel),
      folderFiles: ctx.folderFiles.map((f) => f.name),
      ignoredSubdirs: ctx.ignoredSubdirs,
      lastRun: state.specs[specRel]?.lastRun ?? null,
    };
  }

  // GET /api/config — rootPath e configurazione Hermes (la UI la usa per il primo avvio e il selettore)
  app.get('/api/config', async () => {
    const cfg = await store.load();
    return { rootPath: root, configured: root !== null, hermesModel: cfg.hermesModel, hermesComposeFile: cfg.hermesComposeFile, harnessTestedOk: cfg.harnessTestedOk };
  });

  // PUT /api/harness/hermes — salva modello (stringa libera, vuoto = default) e file compose.
  // Ogni modifica azzera il test: va ripetuto prima di poter allineare.
  app.put<{ Body: { model?: unknown; composeFile?: unknown } }>('/api/harness/hermes', async (req, reply) => {
    const cur = await store.load();
    const model = typeof req.body?.model === 'string' && req.body.model.trim() !== '' ? req.body.model.trim() : null;
    const composeFile = typeof req.body?.composeFile === 'string' && req.body.composeFile.trim() !== '' ? req.body.composeFile.trim() : cur.hermesComposeFile;
    if (!composeFile || !path.isAbsolute(composeFile)) {
      return reply.code(400).send({ error: 'composeFile deve essere un percorso assoluto al docker-compose.yml di Hermes' });
    }
    await store.save({ ...cur, hermesModel: model, hermesComposeFile: composeFile, harnessTestedOk: false });
    return { ok: true, hermesModel: model, hermesComposeFile: composeFile, harnessTestedOk: false };
  });

  // POST /api/harness/hermes/test — esegue davvero Hermes con un prompt di prova.
  app.post('/api/harness/hermes/test', async (_req, reply) => {
    const cfg = await store.load();
    if (!cfg.hermesComposeFile) return reply.code(400).send({ error: 'configura prima composeFile (PUT /api/harness/hermes)' });
    const harness = new HermesHarness({ composeFile: cfg.hermesComposeFile, model: cfg.hermesModel ?? undefined });
    const tmp = process.cwd();
    try {
      const res = await harness.run('Rispondi solo con la parola OK', { cwd: tmp, timeoutMs: 120_000 });
      const ok = res.exitCode === 0 && /\bOK\b/.test(res.output);
      await store.save({ ...cfg, harnessTestedOk: ok });
      return { ok, exitCode: res.exitCode, output: res.output.slice(-2000) };
    } catch (err) {
      await store.save({ ...cfg, harnessTestedOk: false });
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/config — imposta o cambia rootPath (rifiutato se ci sono run attivi)
  app.put<{ Body: { rootPath?: unknown } }>('/api/config', async (req, reply) => {
    let abs: string;
    try {
      abs = await validateRootPath(req.body?.rootPath);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (hasActiveRuns()) {
      return reply.code(409).send({ error: 'impossibile cambiare rootPath: ci sono run attivi' });
    }
    await store.save({ ...(await store.load()), rootPath: abs, harnessTestedOk: (await store.load()).harnessTestedOk });
    root = abs;
    return { ok: true, rootPath: root, configured: true };
  });

  // POST /api/project/rescan
  app.post('/api/project/rescan', async (_req, reply) => {
    if (!root) return notConfigured(reply);
    const a = await analyzeProject(root, { readSpec });
    return { ok: true, specs: a.specs.length, errors: a.errors.length };
  });

  // GET /api/fs/tree?dir=<rel> — sottocartelle e file diretti per l'explorer
  const HIDDEN_DIRS = new Set(['node_modules', 'dist', 'data']);
  app.get<{ Querystring: { dir?: string } }>('/api/fs/tree', async (req, reply) => {
    if (!root) return notConfigured(reply);
    const dirRel = (req.query.dir ?? '').split('\\').join('/').replace(/^\/+|\/+$/g, '');
    const abs = path.resolve(root, dirRel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return reply.code(400).send({ error: 'percorso fuori dal progetto' });
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !HIDDEN_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    return {
      dir: dirRel,
      dirs: dirs.map((name) => ({ name, rel: [dirRel, name].filter(Boolean).join('/') })),
      files: files.map((name) => ({ name, spec: name.endsWith('.helpai.md') })),
      hasSpec: files.some((f) => f.endsWith('.helpai.md')),
    };
  });

  // POST /api/fs/spec — crea .helpai.md nella cartella scelta (solo se non esiste già)
  app.post<{ Body: { dir?: unknown } }>('/api/fs/spec', async (req, reply) => {
    if (!root) return notConfigured(reply);
    const dirRel = typeof req.body?.dir === 'string' ? req.body.dir.split('\\').join('/').replace(/^\/+|\/+$/g, '') : '';
    const abs = path.resolve(root, dirRel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return reply.code(400).send({ error: 'percorso fuori dal progetto' });
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith('.helpai.md'))) {
      return reply.code(409).send({ error: 'in questa cartella esiste già uno .helpai.md' });
    }
    const name = path.basename(abs) || 'progetto';
    await fs.writeFile(path.join(abs, '.helpai.md'), `# ${name}\n\nDescrivi qui cosa deve fare questa cartella.\n`, { flag: 'wx' });
    return { ok: true, specRel: [dirRel, '.helpai.md'].filter(Boolean).join('/') };
  });

  // GET /api/project — stato generale, grafo, errori
  app.get('/api/project', async (_req, reply) => {
    if (!root) return notConfigured(reply);
    const a = await analyzeProject(root, { readSpec });
    const state = await loadState(root);
    const nodes = [];
    for (const s of a.specs) nodes.push(await nodeView(rel(s.specPath), a.graph, a.errors, state));
    const counts = { total: nodes.length, synced: 0, stale: 0, error: 0, never: 0 };
    for (const n of nodes) counts[n.status]++;
    return {
      rootPath: root,
      counts,
      nodes,
      edges: a.specs.flatMap((s) => a.graph.upstream(s.specPath).map((u) => ({ from: rel(u), to: rel(s.specPath) }))),
      errors: a.errors.map((e) => ({ ...e, paths: e.paths.map((p) => rel(p)) })),
      stateVersion: state.version,
    };
  });

  // GET /api/specs/:id
  app.get<{ Params: { id: string } }>('/api/specs/:id', async (req, reply) => {
    if (!root) return notConfigured(reply);
    const specRel = fromId(req.params.id);
    const a = await analyzeProject(root, { readSpec });
    const specPath = path.join(root, specRel);
    if (!a.graph.nodes.has(specPath)) return reply.code(404).send({ error: 'spec non trovata' });
    const state = await loadState(root);
    const content = await fs.readFile(specPath, 'utf8');
    return { ...(await nodeView(req.params.id, a.graph, a.errors, state)), content };
  });

  // PUT /api/specs/:id — salva il .helpai.md dalla UI
  app.put<{ Params: { id: string }; Body: { content?: string } }>('/api/specs/:id', async (req, reply) => {
    if (!root) return notConfigured(reply);
    const specPath = path.join(root, fromId(req.params.id));
    if (typeof req.body?.content !== 'string') return reply.code(400).send({ error: 'content mancante' });
    try {
      await fs.access(specPath);
    } catch {
      return reply.code(404).send({ error: 'spec non trovata' });
    }
    await fs.writeFile(specPath, req.body.content, 'utf8');
    const a = await analyzeProject(root, { readSpec });
    return { ok: true, errors: a.errors.filter((e) => e.paths.includes(specPath)) };
  });

  // GET /api/specs/:id/history?a=&b= — ultimi run e confronto file per file
  app.get<{ Params: { id: string }; Querystring: { a?: string; b?: string } }>(
    '/api/specs/:id/history',
    async (req, reply) => {
      if (!root) return notConfigured(reply);
      const history = await readHistory(root, fromId(req.params.id));
      const meta = history.map((h) => ({ id: h.id, at: h.at, mode: h.mode, files: Object.keys(h.files) }));
      const { a, b } = req.query;
      if (!a || !b) return { history: meta };
      const ha = history.find((h) => h.id === a);
      const hb = history.find((h) => h.id === b);
      if (!ha || !hb) return reply.code(404).send({ history: meta, error: 'snapshot non trovato' });
      return { history: meta, comparison: compareFiles(ha.files, hb.files) };
    },
  );

  // POST /api/specs/:id/align — Spec -> Code, asincrono.
  // Bloccato (409) se la configurazione dell'harness non è stata testata con successo.
  app.post<{ Params: { id: string }; Body: { mode?: string } }>('/api/specs/:id/align', async (req, reply) => {
    if (!root) return notConfigured(reply);
    const cfg = await store.load();
    if (!cfg.harnessTestedOk) {
      return reply.code(409).send({ error: 'harness non verificato: esegui il test della configurazione Hermes prima di allineare' });
    }
    const mode = req.body?.mode ?? 'ctrl';
    if (mode !== 'yolo' && mode !== 'ctrl') return reply.code(400).send({ error: 'mode non valida' });
    const runRoot = root;
    const specRel = fromId(req.params.id);
    const rec = runs.create(req.params.id, mode);
    void (async () => {
      try {
        const result = await alignSpec(runRoot, specRel, {
          mode,
          harness: cfg.hermesComposeFile
            ? new HermesHarness({ composeFile: cfg.hermesComposeFile, model: cfg.hermesModel ?? undefined })
            : opts.harness,
          contract: cfg.hermesComposeFile ? 'files' : 'direct',
          timeoutMs: opts.timeoutMs,
          readSpec,
          onLog: (line) => runs.log(rec.id, line),
          approve: mode === 'ctrl' ? (d) => runs.requestApproval(rec.id, d) : undefined,
        });
        runs.finish(rec.id, result);
      } catch (err) {
        if (err instanceof BlockingValidationError) {
          runs.fail(rec.id, `${err.message}: ${err.errors.map((e) => e.code).join(', ')}`);
        } else {
          runs.fail(rec.id, err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return reply.code(202).send({ runId: rec.id, status: rec.status });
  });

  // POST /api/specs/:id/reverse-align — Code -> Spec, non ancora implementato
  app.post('/api/specs/:id/reverse-align', async (_req, reply) =>
    reply.code(501).send({ error: 'Code -> Spec non ancora implementato' }),
  );

  app.get('/api/runs', async () => ({ runs: runs.list() }));

  app.post<{ Params: { runId: string }; Body: { keep?: boolean } }>('/api/runs/:runId/decision', async (req, reply) => {
    const ok = runs.answer(req.params.runId, Boolean(req.body?.keep));
    if (!ok) return reply.code(409).send({ error: 'nessuna approvazione in attesa per questo run' });
    return { ok: true };
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/stream', async (req, reply) => {
    const rec = runs.get(req.params.runId);
    if (!rec) return reply.code(404).send({ error: 'run non trovato' });
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (r: unknown) => reply.raw.write(`data: ${JSON.stringify(r)}\n\n`);
    send(rec);
    const listener = (updated: typeof rec) => {
      if (updated.id === rec.id) send(updated);
    };
    runs.on('update', listener);
    req.raw.on('close', () => runs.off('update', listener));
    return reply;
  });

  return app;
}
