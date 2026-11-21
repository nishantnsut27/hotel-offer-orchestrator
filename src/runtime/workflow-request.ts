import { isGrpcDeadline } from '../api/errors';
import { DeadlineError, InfrastructureUnavailableError } from '../domain/errors';
import { withTimeout } from './timeout';

interface RequestHandle<T> {
  result(): Promise<T>;
  cancel(): Promise<unknown>;
}

interface WorkflowRequest<T> {
  milliseconds: number;
  beforeStart?: () => Promise<void>;
  start: (deadline: number, resultSignal: AbortSignal) => Promise<RequestHandle<T>>;
  getHandle: () => Pick<RequestHandle<T>, 'cancel'>;
  cancellationFailed: () => void;
  signal?: AbortSignal;
}

export async function executeWorkflowRequest<T>({
  milliseconds,
  beforeStart,
  start,
  getHandle,
  cancellationFailed,
  signal,
}: WorkflowRequest<T>): Promise<T> {
  const deadline = Date.now() + milliseconds;
  let handle: RequestHandle<T> | undefined;
  let expired = false;
  let starting = false;
  const polling = new AbortController();
  let rejectShutdown: (error: Error) => void = () => undefined;
  const shutdown = new Promise<never>((_resolve, reject) => {
    rejectShutdown = reject;
  });
  const onShutdown = () => {
    expired = true;
    rejectShutdown(new InfrastructureUnavailableError('Application is stopping'));
    polling.abort();
  };
  signal?.addEventListener('abort', onShutdown, { once: true });
  if (signal?.aborted) onShutdown();
  const cancel = (target: Pick<RequestHandle<T>, 'cancel'>) => {
    return withTimeout(
      Promise.resolve().then(() => target.cancel()),
      2000,
    )
      .then(() => undefined)
      .catch(cancellationFailed);
  };
  const execute = async () => {
    await beforeStart?.();
    // Readiness may finish after the HTTP deadline; it must not create abandoned work.
    if (expired || Date.now() >= deadline) throw new DeadlineError('Operation deadline exceeded');
    starting = true;
    handle = await start(deadline, polling.signal);
    if (expired) {
      // A cancellation by ID may have arrived before Temporal accepted the start.
      void cancel(handle);
      throw new DeadlineError('Operation deadline exceeded');
    }
    return await handle.result();
  };
  try {
    return await withTimeout(Promise.race([execute(), shutdown]), milliseconds);
  } catch (error) {
    if (expired || error instanceof DeadlineError || isGrpcDeadline(error)) {
      expired = true;
      polling.abort();
      if (starting) {
        try {
          const cancellation = cancel(handle ?? getHandle());
          if (signal?.aborted) await cancellation;
        } catch {
          cancellationFailed();
        }
      }
    }
    throw error;
  } finally {
    polling.abort();
    signal?.removeEventListener('abort', onShutdown);
  }
}
