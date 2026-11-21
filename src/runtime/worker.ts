import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Worker } from '@temporalio/worker';
import type { NativeConnection } from '@temporalio/worker';
import { createProbeActivities } from '../activities/infrastructure';
import { createHotelActivities } from '../activities/hotels';
import type { AppConfig } from '../config/env';
import type { Logger } from '../logger';
import type { RedisConnection } from '../redis/client';
import { workerHeartbeatKey } from '../redis/client';

export async function startWorker(
  config: AppConfig,
  connection: NativeConnection,
  redis: RedisConnection,
  log: Logger,
  onFailure: () => void,
): Promise<() => Promise<void>> {
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowBundle: { codePath: resolve(__dirname, '../workflow-bundle.js') },
    activities: {
      ...createProbeActivities(redis, log),
      ...createHotelActivities(config, redis, log),
    },
    maxCachedWorkflows: 5,
    maxConcurrentWorkflowTaskExecutions: 2,
    maxConcurrentActivityTaskExecutions: 4,
    shutdownGraceTime: '5 seconds',
    shutdownForceTime: '7 seconds',
  });
  let stopping = false;
  const key = workerHeartbeatKey(config);
  const identity = randomUUID();
  const run = worker.run();
  void run.then(
    () => {
      if (!stopping) onFailure();
    },
    (error: unknown) => {
      log('error', 'worker.failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      if (!stopping) onFailure();
    },
  );

  const refresh = async () => {
    if (stopping || worker.getState() !== 'RUNNING') return;
    await redis.withCommandOptions({ timeout: 2000 }).set(key, identity, { EX: 15 });
  };
  let heartbeat = refresh().catch(() => log('warn', 'worker.heartbeat_failed'));
  const timer = setInterval(() => {
    heartbeat = refresh().catch(() => log('warn', 'worker.heartbeat_failed'));
  }, 5000);
  timer.unref();
  await heartbeat;
  log('info', 'worker.started', { namespace: config.namespace, taskQueue: config.taskQueue });

  return async () => {
    stopping = true;
    clearInterval(timer);
    await heartbeat;
    await redis
      .withCommandOptions({ timeout: 500 })
      .eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        { keys: [key], arguments: [identity] },
      )
      .catch(() => log('warn', 'worker.heartbeat_cleanup_deferred'));
    if (worker.getState() === 'RUNNING') worker.shutdown();
    await run.catch(() => undefined);
  };
}
