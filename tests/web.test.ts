import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server/index.js';
import { MockHarness } from '../src/harness/adapters.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'helpai-web-'));
  app = await buildServer({ configFile: path.join(dir, 'config.json'), harness: new MockHarness(() => {}) });
  return app;
}

describe('Web UI statica', () => {
  it('serve index.html su /', async () => {
    const a = await server();
    const res = await a.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('id="graph"');
    expect(res.body).toContain('id="setup"');
  });

  it('serve app.js, app.css e il vendor cytoscape', async () => {
    const a = await server();
    for (const url of ['/app.js', '/app.css', '/vendor/cytoscape.min.js']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body.length, url).toBeGreaterThan(100);
    }
  });

  it('le API restano raggiungibili accanto alla UI', async () => {
    const a = await server();
    const res = await a.inject({ method: 'GET', url: '/api/config' });
    expect(res.json()).toMatchObject({ rootPath: null, configured: false });
  });
});
