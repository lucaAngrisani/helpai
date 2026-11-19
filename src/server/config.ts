import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  rootPath: string | null;
  /** Modello Hermes (stringa libera). Vuoto/null = default di Hermes. */
  hermesModel: string | null;
  /** Percorso docker-compose.yml di Hermes. */
  hermesComposeFile: string | null;
  /** Ultimo test dell'harness riuscito per la configurazione corrente (null = non testato). */
  harnessTestedOk: boolean;
}

/** Persistent app config (rootPath dalla Web UI, configurazione harness). */
export class ConfigStore {
  constructor(readonly file: string) {}

  async load(): Promise<AppConfig> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<AppConfig>;
      return {
        rootPath: typeof raw.rootPath === 'string' ? raw.rootPath : null,
        hermesModel: typeof raw.hermesModel === 'string' && raw.hermesModel.trim() !== '' ? raw.hermesModel.trim() : null,
        hermesComposeFile: typeof raw.hermesComposeFile === 'string' ? raw.hermesComposeFile : null,
        harnessTestedOk: raw.harnessTestedOk === true,
      };
    } catch {
      return { rootPath: null, hermesModel: null, hermesComposeFile: null, harnessTestedOk: false };
    }
  }

  async save(cfg: AppConfig): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
}

/** Accepts only an absolute path to an existing directory. Returns the normalized path. */
export async function validateRootPath(input: unknown): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('rootPath mancante');
  if (!path.isAbsolute(input)) throw new Error('rootPath deve essere un percorso assoluto');
  const abs = path.resolve(input);
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Directory non esistente: ${abs}`);
  return abs;
}
