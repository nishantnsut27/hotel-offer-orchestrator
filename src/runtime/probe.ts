import type { Client } from '@temporalio/client';
import type { AppConfig } from '../config/env';
import type { ProbeResult } from '../domain/infrastructure';
import type { Logger } from '../logger';
import type { infrastructureProbeWorkflow } from '../workflows/infrastructure';
import { executeWorkflowRequest } from './workflow-request';

export async function executeInfrastructureProbe(
  client: Client,
  config: AppConfig,
  workflowId: string,
  log: Logger,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProbeResult> {
  return await executeWorkflowRequest({
    milliseconds: 20_000,
    signal,
    start: async (deadline, resultSignal) => {
      const handle = await client.connection.withDeadline(deadline, () =>
        client.workflow.start<typeof infrastructureProbeWorkflow>('infrastructureProbeWorkflow', {
          workflowId,
          taskQueue: config.taskQueue,
          args: [workflowId],
          workflowExecutionTimeout: '15 seconds',
        }),
      );
      return {
        result: () => client.connection.withAbortSignal(resultSignal, () => handle.result()),
        cancel: () => handle.cancel(),
      };
    },
    getHandle: () => client.workflow.getHandle(workflowId),
    cancellationFailed: () => log('warn', 'probe.cancellation_failed', { workflowId }),
  });
}
