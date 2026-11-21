import { ApplicationFailure, Context } from '@temporalio/activity';
import type { ProbeActivities, ProbeResult } from '../domain/infrastructure';
import type { Logger } from '../logger';
import type { RedisConnection } from '../redis/client';

// Keep write, query, and cleanup atomic so a timed-out attempt cannot disturb its retry.
const probeScript = `
local key = KEYS[1]
redis.call('DEL', key)
redis.call('ZADD', key, 100, 'low', 200, 'high')
redis.call('EXPIRE', key, 60)
local matches = redis.call('ZRANGEBYSCORE', key, 100, 100)
redis.call('DEL', key)
return matches
`;

export function createProbeActivities(redis: RedisConnection, log: Logger): ProbeActivities {
  return {
    async probeRedis(workflowId: string): Promise<ProbeResult> {
      const key = `hotel-offers:probe:${workflowId}`;
      const context = Context.current();
      const commands = redis.withCommandOptions({
        timeout: 2000,
        abortSignal: context.cancellationSignal,
      });
      log('info', 'probe.activity_started', { workflowId, attempt: context.info.attempt });

      try {
        const matches: unknown = await commands.eval(probeScript, { keys: [key] });
        if (!Array.isArray(matches) || matches.length !== 1 || matches[0] !== 'low') {
          throw ApplicationFailure.nonRetryable(
            'Redis score query returned unexpected data',
            'ProbeVerificationFailed',
          );
        }
        return { workflowId, redis: 'ok' };
      } catch (error) {
        log('warn', 'probe.activity_failed', {
          workflowId,
          attempt: context.info.attempt,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        if (error instanceof ApplicationFailure) throw error;
        throw ApplicationFailure.retryable('Redis probe is unavailable', 'RedisUnavailable');
      }
    },
  };
}
