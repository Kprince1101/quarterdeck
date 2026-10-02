import { AcpClientError } from './errors.js';

export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

export interface InitializeDeadline {
  signal: AbortSignal;
  error: () => AcpClientError;
}

export const createInitializeDeadline = (
  timeoutMs: number,
  signal: AbortSignal | undefined,
): InitializeDeadline => {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  const error = () => {
    if (signal?.aborted) {
      return new AcpClientError(
        'ACP initialize was aborted',
        'initialize_timeout',
      );
    }
    return new AcpClientError(
      `Agent did not answer initialize within ${timeoutMs}ms`,
      'initialize_timeout',
    );
  };

  return { signal: AbortSignal.any(signals), error };
};

export const raceAbort = <T>(
  work: Promise<T>,
  { signal, error }: InitializeDeadline,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(error());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = () => signal.removeEventListener('abort', onAbort);
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (err: unknown) => {
        settle();
        reject(err);
      },
    );
  });
