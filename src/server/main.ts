import path from 'node:path';
import { buildServer } from './index.js';
import { CliHarness, MockHarness, type CodingHarness } from '../harness/adapters.js';

/**
 * Entrypoint. Il progetto target NON è un parametro di avvio: si imposta dalla Web UI
 * (PUT /api/config) e viene salvato in HELPAI_DATA_DIR/config.json.
 * Variabili: HELPAI_PORT (default 4321), HELPAI_DATA_DIR (default ./data),
 * HELPAI_HARNESS=mock|cli, HELPAI_HARNESS_CMD, HELPAI_HARNESS_ARGS (separati da spazio).
 */
async function main(): Promise<void> {
  const port = Number(process.env.HELPAI_PORT ?? 4321);
  const dataDir = path.resolve(process.env.HELPAI_DATA_DIR ?? path.join(process.cwd(), 'data'));
  const harness: CodingHarness =
    process.env.HELPAI_HARNESS === 'cli' && process.env.HELPAI_HARNESS_CMD
      ? new CliHarness(
          'cli',
          process.env.HELPAI_HARNESS_CMD,
          (process.env.HELPAI_HARNESS_ARGS ?? '').split(' ').filter(Boolean),
        )
      : new MockHarness(() => {});

  const app = await buildServer({ configFile: path.join(dataDir, 'config.json'), harness, logger: true });
  await app.listen({ port, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
