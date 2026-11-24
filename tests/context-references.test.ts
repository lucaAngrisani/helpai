import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/core/analyze.js';
import { buildContext } from '../src/core/context.js';
import { buildPrompt } from '../src/harness/prompt.js';

describe('contesto: file referenziati dai link', () => {
  it('include i file della spec collegata come sola lettura', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'helpai-ref-'));
    await mkdir(path.join(root, 'canzoni'), { recursive: true });
    await mkdir(path.join(root, 'album'), { recursive: true });
    await writeFile(path.join(root, 'canzoni', 'canzoni.helpai.md'), '# Canzoni\nmodello Canzone');
    await writeFile(path.join(root, 'canzoni', 'canzone.model.ts'), 'export interface Canzone { id: number }');
    await writeFile(path.join(root, 'album', 'album.helpai.md'), '# Album\nusa [canzoni](../canzoni/canzoni.helpai.md)');
    await writeFile(path.join(root, 'album', 'album.component.ts'), 'export class AlbumComponent {}');

    const analysis = await analyzeProject(root, {});
    const ctx = await buildContext(root, analysis.graph, path.join(root, 'album', 'album.helpai.md'), async (p) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(p, 'utf8').catch(() => null);
    });

    const rels = ctx.referenced.map((r) => r.rel).sort();
    expect(rels).toContain('canzoni/canzoni.helpai.md');
    expect(rels).toContain('canzoni/canzone.model.ts');
    expect(rels).not.toContain('album/album.component.ts');

    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('File di riferimento (SOLO LETTURA)');
    expect(prompt).toContain('export interface Canzone');
  });
});
