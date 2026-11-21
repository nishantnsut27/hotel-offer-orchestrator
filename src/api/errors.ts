import {
  ActivityFailure,
  ApplicationFailure,
  ServiceError,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import { DeadlineError, InfrastructureUnavailableError } from '../domain/errors';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isGrpcDeadline(error: unknown): boolean {
  if (!(error instanceof ServiceError)) return false;
  const cause = error.cause;
  return cause instanceof Error && 'code' in cause && cause.code === 4;
}

export function mapHotelSearchError(error: unknown): HttpError {
  let cause = error;
  let activityFailed = false;
  for (let depth = 0; depth < 10; depth++) {
    if (cause instanceof ActivityFailure) activityFailed = true;
    if (!(cause instanceof Error) || !cause.cause) break;
    cause = cause.cause;
  }
  if (
    error instanceof DeadlineError ||
    isGrpcDeadline(error) ||
    (cause instanceof TimeoutFailure && !activityFailed)
  ) {
    return new HttpError(504, 'HOTEL_SEARCH_TIMEOUT', 'Hotel search timed out');
  }
  if (
    error instanceof InfrastructureUnavailableError ||
    error instanceof ServiceError ||
    (cause instanceof TimeoutFailure && activityFailed) ||
    (cause instanceof ApplicationFailure &&
      [
        'SupplierUnavailable',
        'SupplierInvalidPayload',
        'SupplierRequestRejected',
        'RedisUnavailable',
      ].includes(cause.type ?? ''))
  ) {
    return new HttpError(503, 'HOTEL_SEARCH_UNAVAILABLE', 'Hotel search is unavailable');
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

export function mapProbeError(error: unknown): HttpError {
  let cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error && cause.cause; depth++) {
    cause = cause.cause;
  }

  const grpcDeadline =
    error instanceof ServiceError && cause instanceof Error && 'code' in cause && cause.code === 4;
  if (error instanceof DeadlineError || cause instanceof TimeoutFailure || grpcDeadline) {
    return new HttpError(504, 'PROBE_TIMEOUT', 'Infrastructure probe timed out');
  }
  if (cause instanceof ApplicationFailure && cause.type === 'ProbeVerificationFailed') {
    return new HttpError(500, 'PROBE_FAILED', 'Infrastructure verification failed');
  }
  if (
    error instanceof InfrastructureUnavailableError ||
    error instanceof ServiceError ||
    error instanceof WorkflowFailedError
  ) {
    return new HttpError(503, 'INFRASTRUCTURE_UNAVAILABLE', 'Infrastructure is unavailable');
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
