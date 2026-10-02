import type {
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  ConformanceHooks,
  PermissionDecider,
  RecordedUpdate,
} from './types.ts';

export const CONFORMANCE_TIMEOUT_MS = 5000;

export interface Recorder {
  hooks: ConformanceHooks;
  updates: RecordedUpdate[];
  permissionRequests: RequestPermissionRequest[];
  waitFor: (label: string, predicate: () => boolean) => Promise<void>;
}

export const withTimeout = <T>(
  label: string,
  promise: Promise<T>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      CONFORMANCE_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export const createRecorder = (decide: PermissionDecider): Recorder => {
  const updates: RecordedUpdate[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const waitFor = (label: string, predicate: () => boolean): Promise<void> => {
    let listener = () => {};
    const settled = new Promise<void>((resolve) => {
      listener = () => {
        if (predicate()) resolve();
      };
      listeners.add(listener);
      listener();
    });
    return withTimeout(label, settled).finally(() =>
      listeners.delete(listener),
    );
  };

  const decidePermission = (
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionOutcome> => {
    permissionRequests.push(request);
    notify();
    return decide(request);
  };

  const onUpdate = (sessionId: string, update: SessionUpdate) => {
    updates.push({ sessionId, update });
    notify();
  };

  return {
    hooks: { decidePermission, onUpdate },
    updates,
    permissionRequests,
    waitFor,
  };
};
