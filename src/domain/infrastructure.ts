export type CheckStatus = 'up' | 'down' | 'not_configured';

export interface InfrastructureChecks {
  api: CheckStatus;
  worker: CheckStatus;
  temporal: CheckStatus;
  redis: CheckStatus;
}

export interface ProbeResult {
  workflowId: string;
  redis: 'ok';
}

export interface SupplierChecks {
  supplierA: CheckStatus;
  supplierB: CheckStatus;
}

export interface ProbeActivities {
  probeRedis(workflowId: string): Promise<ProbeResult>;
}

export function infrastructureReady(checks: InfrastructureChecks): boolean {
  return Object.values(checks).every((status) => status === 'up');
}
