import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { alignSpec, BlockingValidationError } from '../src/core/runner.js';
import { MockHarness } from '../src/harness/adapters.js';
import { lineDiff, compareFiles } from '../src/core/diff.js';
import { readHistory, loadState } from '../src/core/state.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'helpai-m2-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const base = {
  'component-base.helpai.md': '# Base spec',
  'components/card/card.helpai.md': '# Card\n[Base](../../component-base.helpai.md)\nRender a card.',
  'components/card/index.ts': 'export const v = 1;\n',
  'components/card/sub/nested.ts': 'nested\n',
  'components/other/other.ts': 'other\n',
};
const CARD = 'components/card/card.helpai.md';

describe('lineDiff', () => {
  it('mostra righe aggiunte e rimosse', () => {
    expect(lineDiff('a\nb', 'a\nc')).toBe(' a\n-b\n+c');
  });
});

describe('alignSpec — YOLO', () => {
  it('mantiene le modifiche nel perimetro e annulla quelle fuori', async () => {
    const root = fixture(base);
    const harness = new MockHarness((cwd) => {
      writeFileSync(path.join(cwd, 'components/card/card.ts'), 'new\n'); // in perimetro
      writeFileSync(path.join(cwd, 'components/other/other.ts'), 'hacked\n'); // fuori
      writeFileSync(path.join(cwd, 'components/card/sub/nested.ts'), 'hacked\n'); // sottocartella
      writeFileSync(path.join(cwd, CARD), 'overwritten'); // spec
    });
    const r = await alignSpec(root, CARD, { mode: 'yolo', harness });

    expect(r.applied.map((c) => c.path)).toEqual(['components/card/card.ts']);
    expect(readFileSync(path.join(root, 'components/other/other.ts'), 'utf8')).toBe('other\n');
    expect(readFileSync(path.join(root, 'components/card/sub/nested.ts'), 'utf8')).toBe('nested\n');
    expect(readFileSync(path.join(root, CARD), 'utf8')).toContain('# Card');
    expect(r.reverted.map((x) => x.reason).sort()).toEqual(['outside-perimeter', 'outside-perimeter', 'spec-file']);
  });

  it('il prompt contiene la spec ereditata e i file della sola cartella', async () => {
    const root = fixture(base);
    const harness = new MockHarness(() => {});
    await alignSpec(root, CARD, { mode: 'yolo', harness });
    const prompt = harness.prompts[0]!;
    expect(prompt).toContain('# Base spec');
    expect(prompt).toContain('export const v = 1;');
    expect(prompt).not.toContain('nested');
    expect(prompt).not.toContain('other');
  });
});

describe('alignSpec — CTRL', () => {
  it('riverte i file rifiutati e mantiene quelli approvati', async () => {
    const root = fixture(base);
    const harness = new MockHarness((cwd) => {
      writeFileSync(path.join(cwd, 'components/card/keep.ts'), 'keep\n');
      writeFileSync(path.join(cwd, 'components/card/index.ts'), 'changed\n');
    });
    const asked: string[] = [];
    const r = await alignSpec(root, CARD, {
      mode: 'ctrl',
      harness,
      approve: async (d) => {
        asked.push(d.change.path);
        return d.change.path.endsWith('keep.ts');
      },
    });
    expect(asked.sort()).toEqual(['components/card/index.ts', 'components/card/keep.ts']);
    expect(r.applied.map((c) => c.path)).toEqual(['components/card/keep.ts']);
    expect(existsSync(path.join(root, 'components/card/keep.ts'))).toBe(true);
    expect(readFileSync(path.join(root, 'components/card/index.ts'), 'utf8')).toBe('export const v = 1;\n');
  });

  it('richiede approve in modalità CTRL', async () => {
    const root = fixture(base);
    await expect(alignSpec(root, CARD, { mode: 'ctrl', harness: new MockHarness(() => {}) })).rejects.toThrow(/approve/);
  });
});

describe('alignSpec — validazione e stato', () => {
  it('blocca se la spec o le sue basi hanno errori', async () => {
    const root = fixture({ ...base, 'components/card/broken.helpai.md': '# dup' });
    await expect(alignSpec(root, CARD, { mode: 'yolo', harness: new MockHarness(() => {}) })).rejects.toBeInstanceOf(
      BlockingValidationError,
    );
  });

  it('salva stato e rileva lo stato stale dopo una modifica alla spec base', async () => {
    const root = fixture(base);
    await alignSpec(root, CARD, { mode: 'yolo', harness: new MockHarness(() => {}) });
    const state = await loadState(root);
    expect(state.specs[CARD]).toBeDefined();
    expect(state.specs[CARD]!.lastRun?.mode).toBe('yolo');
    expect(existsSync(path.join(root, '.helpai/state.json'))).toBe(true);
  });

  it('conserva solo gli ultimi 3 storici e permette il confronto', async () => {
    const root = fixture(base);
    for (let i = 1; i <= 4; i++) {
      const harness = new MockHarness((cwd) => writeFileSync(path.join(cwd, 'components/card/index.ts'), `v${i}\n`));
      await alignSpec(root, CARD, { mode: 'yolo', harness });
    }
    const history = await readHistory(root, CARD);
    expect(history).toHaveLength(3);
    const cmp = compareFiles(history[1]!.files, history[0]!.files);
    const idx = cmp.find((c) => c.name === 'index.ts');
    expect(idx?.status).toBe('modified');
    expect(idx?.diff).toContain('-v3');
    expect(idx?.diff).toContain('+v4');
  });
});
