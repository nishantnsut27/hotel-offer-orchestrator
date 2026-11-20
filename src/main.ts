import { once } from 'node:events';
import { createApp } from './api/app';
import { loadConfig } from './config/env';
import { createLogger } from './logger';

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const server = createApp({ log }).listen(config.port, '0.0.0.0');
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;

  await once(server, 'listening');
  log('info', 'server.started', { port: config.port, environment: config.environment });

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log('info', 'server.stopping', { signal });

    const deadline = setTimeout(() => {
      log('error', 'server.shutdown_timeout');
      server.closeAllConnections();
      process.exitCode = 1;
    }, 10_000);
    deadline.unref();

    server.close((error) => {
      clearTimeout(deadline);
      if (error) {
        log('error', 'server.shutdown_failed', { errorType: error.name });
        process.exitCode = 1;
        return;
      }

      log('info', 'server.stopped');
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error: unknown) => {
  createLogger('error')('error', 'server.startup_failed', {
    message: error instanceof Error ? error.message : 'Unknown startup error',
  });
  process.exitCode = 1;
});
