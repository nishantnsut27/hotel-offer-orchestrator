import { spawn } from 'node:child_process';
import type { AppConfig } from '../config/env';
import type { Logger } from '../logger';
import { withTimeout } from './timeout';

export function startTemporalServer(config: AppConfig, log: Logger, onFailure: () => void) {
  let stopping = false;
  const port = config.temporalAddress.slice(config.temporalAddress.lastIndexOf(':') + 1);
  const child = spawn(
    config.temporalCliPath,
    [
      'server',
      'start-dev',
      '--ip',
      '127.0.0.1',
      '--port',
      port,
      '--namespace',
      config.namespace,
      '--headless',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      log('error', 'temporal.process_error', { errorType: error.name });
      if (!stopping) onFailure();
      resolve();
    });
    child.once('exit', (code, signal) => {
      log(stopping ? 'info' : 'error', 'temporal.process_exited', { code, signal });
      if (!stopping) onFailure();
      resolve();
    });
  });
  child.stdout.on('data', (chunk: Buffer) =>
    log('debug', 'temporal.output', { message: chunk.toString().trim().slice(0, 2000) }),
  );
  child.stderr.on('data', (chunk: Buffer) =>
    log('debug', 'temporal.output', { message: chunk.toString().trim().slice(0, 2000) }),
  );

  return async () => {
    stopping = true;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    try {
      await withTimeout(exited, 3000);
    } catch {
      child.kill('SIGKILL');
      await withTimeout(exited, 1000);
    }
  };
}
