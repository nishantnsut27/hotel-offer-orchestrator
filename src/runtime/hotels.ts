import type { Client } from '@temporalio/client';
import type { AppConfig } from '../config/env';
import { InfrastructureUnavailableError } from '../domain/errors';
import type { HotelOffer, HotelWorkflowInput } from '../domain/hotels';
import { infrastructureReady } from '../domain/infrastructure';
import type { InfrastructureChecks } from '../domain/infrastructure';
import type { Logger } from '../logger';
import type { hotelSearchWorkflow } from '../workflows/hotels';
import { executeWorkflowRequest } from './workflow-request';

export async function executeHotelSearch(
  client: Client,
  config: AppConfig,
  workflowId: string,
  input: HotelWorkflowInput,
  log: Logger,
  getInfrastructure: () => Promise<InfrastructureChecks>,
  signal: AbortSignal = new AbortController().signal,
): Promise<HotelOffer[]> {
  return await executeWorkflowRequest({
    milliseconds: 35000,
    signal,
    beforeStart: async () => {
      if (!infrastructureReady(await getInfrastructure())) {
        throw new InfrastructureUnavailableError('Infrastructure is not ready');
      }
    },
    start: async (deadline, resultSignal) => {
      const handle = await client.connection.withDeadline(deadline, () =>
        client.workflow.start<typeof hotelSearchWorkflow>('hotelSearchWorkflow', {
          workflowId,
          taskQueue: config.taskQueue,
          args: [input],
          workflowExecutionTimeout: '30 seconds',
        }),
      );
      return {
        result: () => client.connection.withAbortSignal(resultSignal, () => handle.result()),
        cancel: () => handle.cancel(),
      };
    },
    getHandle: () => client.workflow.getHandle(workflowId),
    cancellationFailed: () =>
      log('warn', 'hotels.cancellation_failed', { workflowId, requestId: input.requestId }),
  });
}
