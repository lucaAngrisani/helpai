import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { analyzeProject } from '../src/core/analyze.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'helpai-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code).sort();

describe('analyzeProject', () => {
  it('riconosce un file .helpai.md con nome nudo', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'helpai-bare-'));
    writeFileSync(path.join(dir, '.helpai.md'), '# Progetto\n');
    mkdirSync(path.join(dir, 'test'));
    writeFileSync(path.join(dir, 'test', '.helpai.md'), '# Test\n');
    const r = await analyzeProject(dir);
    expect(r.specs.map((s) => path.relative(dir, s.specPath).split(path.sep).join('/')).sort()).toEqual(['.helpai.md', 'test/.helpai.md']);
    expect(r.errors).toEqual([]);
  });

  it('rileva specs e costruisce il grafo upstream/downstream', async () => {
    const root = fixture({
      'component-base.helpai.md': '# Base',
      'components/user-card/user-card.helpai.md': '# Card\n[Base](../../component-base.helpai.md)',
    });
    const r = await analyzeProject(root);
    expect(r.errors).toEqual([]);
    expect(r.specs.map((s) => path.relative(root, s.specPath)).sort()).toEqual([
      'component-base.helpai.md',
      'components/user-card/user-card.helpai.md',
    ]);
    const base = path.join(root, 'component-base.helpai.md');
    const card = path.join(root, 'components/user-card/user-card.helpai.md');
    expect(r.graph.upstream(card)).toEqual([base]);
    expect(r.graph.downstream(base)).toEqual([card]);
  });

  it('segnala MULTIPLE_SPEC_FILES_IN_FOLDER', async () => {
    const root = fixture({ 'a/x.helpai.md': '#', 'a/y.helpai.md': '#' });
    const r = await analyzeProject(root);
    expect(codes(r)).toEqual(['MULTIPLE_SPEC_FILES_IN_FOLDER']);
    expect(r.errors[0]!.paths).toHaveLength(2);
  });

  it('segnala BROKEN_SPEC_LINK per link locali inesistenti', async () => {
    const root = fixture({ 'a/a.helpai.md': '[X](../missing.helpai.md)' });
    const r = await analyzeProject(root);
    expect(codes(r)).toEqual(['BROKEN_SPEC_LINK']);
  });

  it('segnala CIRCULAR_SPEC_DEPENDENCY', async () => {
    const root = fixture({
      'a/a.helpai.md': '[B](../b/b.helpai.md)',
      'b/b.helpai.md': '[A](../a/a.helpai.md)',
    });
    const r = await analyzeProject(root);
    expect(codes(r)).toEqual(['CIRCULAR_SPEC_DEPENDENCY']);
  });

  it('ignora sottodirectory escluse e link dentro blocchi di codice', async () => {
    const root = fixture({
      'a/a.helpai.md': '```\n[X](./nope.helpai.md)\n```',
      'node_modules/pkg/p.helpai.md': '#',
    });
    const r = await analyzeProject(root);
    expect(r.errors).toEqual([]);
    expect(r.specs).toHaveLength(1);
  });

  it('accetta link URL raggiungibili tramite resolver iniettato', async () => {
    const root = fixture({ 'a/a.helpai.md': '[R](https://specs.example/base.helpai.md)' });
    const remote = 'https://specs.example/base.helpai.md';
    const r = await analyzeProject(root, {
      readSpec: async (p) => (p === remote ? '# remote' : p.endsWith('a.helpai.md') ? await import('node:fs/promises').then((f) => f.readFile(p, 'utf8')) : null),
    });
    expect(r.errors).toEqual([]);
    expect(r.graph.upstream(path.join(root, 'a/a.helpai.md'))).toEqual([remote]);
  });

  it('segnala BROKEN_SPEC_LINK per URL non raggiungibile', async () => {
    const root = fixture({ 'a/a.helpai.md': '[R](https://specs.example/nope.helpai.md)' });
    const r = await analyzeProject(root, {
      readSpec: async (p) => (p.endsWith('a.helpai.md') ? await import('node:fs/promises').then((f) => f.readFile(p, 'utf8')) : null),
    });
    expect(codes(r)).toEqual(['BROKEN_SPEC_LINK']);
  });
});
