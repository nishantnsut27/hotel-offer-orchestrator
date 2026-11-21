import { proxyActivities } from '@temporalio/workflow';
import type { ProbeActivities, ProbeResult } from '../domain/infrastructure';

const { probeRedis } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: '3 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second', maximumInterval: '1 second' },
});

export async function infrastructureProbeWorkflow(workflowId: string): Promise<ProbeResult> {
  return await probeRedis(workflowId);
}
