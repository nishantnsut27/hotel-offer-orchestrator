export class DeadlineError extends Error {
  override name = 'DeadlineError';
}

export class InfrastructureUnavailableError extends Error {
  override name = 'InfrastructureUnavailableError';
}

export type SupplierFailureType =
  'SupplierUnavailable' | 'SupplierInvalidPayload' | 'SupplierRequestRejected';

export class SupplierError extends Error {
  override name = 'SupplierError';

  constructor(
    message: string,
    readonly type: SupplierFailureType,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class InvalidStoredOffersError extends Error {
  override name = 'InvalidStoredOffersError';
}
