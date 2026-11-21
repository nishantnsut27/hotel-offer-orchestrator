import { createClient } from 'redis';
import type { AppConfig } from '../config/env';
import type { Logger } from '../logger';
import { withTimeout } from '../runtime/timeout';

export function createRedisConnection(url: string, log: Logger) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 128,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (attempt) => Math.min(100 * 2 ** attempt, 1000),
    },
  });
  client.on('error', (error: Error) =>
    log('warn', 'redis.connection_error', { errorType: error.name }),
  );
  return client;
}

export type RedisConnection = ReturnType<typeof createRedisConnection>;

export function workerHeartbeatKey(config: Pick<AppConfig, 'namespace' | 'taskQueue'>): string {
  return `hotel-offers:worker:${encodeURIComponent(config.namespace)}:${encodeURIComponent(config.taskQueue)}`;
}

export async function closeRedis(client: RedisConnection): Promise<void> {
  if (!client.isOpen) return;
  if (!client.isReady) {
    client.destroy();
    return;
  }
  try {
    await withTimeout(client.close(), 1000);
  } catch {
    if (client.isOpen) client.destroy();
  }
}
