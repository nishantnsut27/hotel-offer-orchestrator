import type { Connection } from '@temporalio/client';
import type { AppConfig } from '../config/env';
import type { InfrastructureChecks, SupplierChecks } from '../domain/infrastructure';
import type { RedisConnection } from '../redis/client';
import { workerHeartbeatKey } from '../redis/client';
import { fetchSupplierHotels } from '../suppliers/client';

export async function checkSuppliers(config: AppConfig): Promise<SupplierChecks> {
  const signal = new AbortController().signal;
  const [supplierA, supplierB] = await Promise.allSettled([
    fetchSupplierHotels(config.supplierAUrl, undefined, signal),
    fetchSupplierHotels(config.supplierBUrl, undefined, signal),
  ]);
  return {
    supplierA: supplierA.status === 'fulfilled' ? 'up' : 'down',
    supplierB: supplierB.status === 'fulfilled' ? 'up' : 'down',
  };
}

export async function checkInfrastructure(
  config: AppConfig,
  connection: Connection | undefined,
  redis: RedisConnection | undefined,
  stopping: boolean,
): Promise<InfrastructureChecks> {
  const [temporal, storage] = await Promise.allSettled([
    connection
      ? connection.withDeadline(Date.now() + 2000, () =>
          connection.workflowService.getSystemInfo({}),
        )
      : Promise.reject(new Error('Temporal is not connected')),
    redis?.isReady
      ? Promise.all([
          redis.withCommandOptions({ timeout: 2000 }).ping(),
          redis.withCommandOptions({ timeout: 2000 }).get(workerHeartbeatKey(config)),
        ])
      : Promise.reject(new Error('Redis is not connected')),
  ]);
  const redisReady = storage.status === 'fulfilled' && storage.value[0] === 'PONG';
  const workerReady =
    redisReady && storage.status === 'fulfilled' && typeof storage.value[1] === 'string';
  return {
    api: stopping ? 'down' : 'up',
    temporal: temporal.status === 'fulfilled' ? 'up' : 'down',
    redis: redisReady ? 'up' : 'down',
    worker: workerReady ? 'up' : 'down',
  };
}
