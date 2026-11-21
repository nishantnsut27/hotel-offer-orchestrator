import { loadConfig } from './config/env';
import { createLogger } from './logger';
import { runApplication } from './runtime/application';

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  await runApplication(config, log);
}

void main().catch((error: unknown) => {
  createLogger('error')('error', 'server.startup_failed', {
    message: error instanceof Error ? error.message : 'Unknown startup error',
  });
  process.exitCode = 1;
});
