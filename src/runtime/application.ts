import { once } from 'node:events';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { createApp } from '../api/app';
import type { AppConfig } from '../config/env';
import { InfrastructureUnavailableError } from '../domain/errors';
import type { Logger } from '../logger';
import { closeRedis, createRedisConnection } from '../redis/client';
import type { RedisConnection } from '../redis/client';
import { checkInfrastructure, checkSuppliers } from './health';
import { executeInfrastructureProbe } from './probe';
import { executeHotelSearch } from './hotels';
import { startTemporalServer } from './temporal-server';
import { withTimeout } from './timeout';

export async function runApplication(config: AppConfig, log: Logger): Promise<void> {
  const abort = new AbortController();
  const cleanups: Array<() => Promise<void>> = [];
  let server: Server | undefined;
  let connection: Connection | undefined;
  let client: Client | undefined;
  let redis: RedisConnection | undefined;
  let stopping = false;
  let startup: Promise<void> = Promise.resolve();
  let finish: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const stop = async (reason: string, failed = false) => {
    if (failed) process.exitCode = 1;
    if (stopping) return;
    stopping = true;
    abort.abort();
    log('info', 'application.stopping', { reason });
    const watchdog = setTimeout(() => {
      log('error', 'application.shutdown_timeout');
      server?.closeAllConnections();
      process.exit(1);
    }, 10_000);
    watchdog.unref();
    const httpClosed = server
      ? new Promise<void>((resolve) => server?.close(() => resolve()))
      : Promise.resolve();
    if (redis?.isOpen && !redis.isReady) redis.destroy();
    try {
      await startup.catch(() => undefined);
      // Active HTTP handlers bound their cancellation before connections are closed.
      await httpClosed;
      for (const cleanup of cleanups.reverse()) {
        await cleanup().catch(() => {
          process.exitCode = 1;
          log('error', 'application.cleanup_failed');
        });
      }
      log('info', 'application.stopped');
    } finally {
      clearTimeout(watchdog);
      finish();
    }
  };
  const fatal = () => {
    if (!stopping) void stop('required process failed', true);
  };
  const onInterrupt = () => {
    void stop('SIGINT');
  };
  const onTerminate = () => {
    void stop('SIGTERM');
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  const initialize = async () => {
    if (config.mode !== 'worker') {
      server = createApp({
        log,
        enableInfraProbe: config.enableInfraProbe,
        supplierADown: config.supplierADown,
        supplierBDown: config.supplierBDown,
        getSupplierHealth: () => checkSuppliers(config),
        getInfrastructure: () => checkInfrastructure(config, connection, redis, stopping),
        executeProbe: (workflowId) => {
          if (stopping || !client || !redis?.isReady) {
            return Promise.reject(
              new InfrastructureUnavailableError('Infrastructure is not ready'),
            );
          }
          return executeInfrastructureProbe(client, config, workflowId, log, abort.signal);
        },
        executeHotelSearch: (workflowId, input) => {
          if (stopping || !client || !redis?.isReady) {
            return Promise.reject(
              new InfrastructureUnavailableError('Infrastructure is not ready'),
            );
          }
          return executeHotelSearch(
            client,
            config,
            workflowId,
            input,
            log,
            () => checkInfrastructure(config, connection, redis, stopping),
            abort.signal,
          );
        },
      }).listen(config.port, '0.0.0.0');
      server.requestTimeout = 35_000;
      server.headersTimeout = 10_000;
      await once(server, 'listening');
      server.on('error', fatal);
      server.on('request', (_request, response) => {
        response.once('finish', () => {
          if (stopping) setImmediate(() => server?.closeIdleConnections());
        });
      });
      log('info', 'server.started', { port: config.port, mode: config.mode });
    }
    abort.signal.throwIfAborted();
    if (config.mode === 'demo') cleanups.push(startTemporalServer(config, log, fatal));

    const storage = createRedisConnection(config.redisUrl, log);
    redis = storage;
    cleanups.push(() => closeRedis(storage));
    await storage.connect();
    abort.signal.throwIfAborted();

    while (!connection) {
      abort.signal.throwIfAborted();
      try {
        const connected = await Connection.connect({
          address: config.temporalAddress,
          connectTimeout: '2 seconds',
        });
        connection = connected;
        cleanups.push(() => connected.close());
      } catch {
        await delay(250, undefined, { signal: abort.signal });
      }
    }
    abort.signal.throwIfAborted();
    client = new Client({ connection, namespace: config.namespace });
    if (config.mode !== 'api') {
      const { NativeConnection } = await import('@temporalio/worker');
      const { startWorker } = await import('./worker.js');
      abort.signal.throwIfAborted();
      const native = await NativeConnection.connect({ address: config.temporalAddress });
      cleanups.push(() => native.close());
      abort.signal.throwIfAborted();
      const stopWorker = await startWorker(config, native, redis, log, fatal);
      cleanups.push(stopWorker);
      abort.signal.throwIfAborted();
    }
    log('info', 'application.initialized', { mode: config.mode });
  };

  startup = initialize();
  try {
    await withTimeout(startup, 60_000);
    await stopped;
  } catch (error) {
    if (!stopping) {
      log('error', 'application.startup_failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      await stop('startup failed', true);
    } else {
      await stopped;
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
