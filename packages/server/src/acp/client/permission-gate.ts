import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionId,
} from '@agentclientprotocol/sdk';
import type { PermissionHandler } from './types.js';

export const CANCELLED_PERMISSION: RequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};

export interface PermissionGate {
  request: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  beginTurn: (sessionId: SessionId) => void;
  cancelTurn: (sessionId: SessionId) => void;
  cancelAll: () => void;
}

export const createPermissionGate = (
  handler: PermissionHandler,
): PermissionGate => {
  const pending = new Map<SessionId, Set<() => void>>();
  const cancelledTurns = new Set<SessionId>();

  const settleSession = (sessionId: SessionId) => {
    pending.get(sessionId)?.forEach((settle) => settle());
    pending.delete(sessionId);
  };

  const track = (sessionId: SessionId, settle: () => void) => {
    const settles = pending.get(sessionId) ?? new Set<() => void>();
    settles.add(settle);
    pending.set(sessionId, settles);
    return () => {
      settles.delete(settle);
    };
  };

  const request = async (permission: RequestPermissionRequest) => {
    if (cancelledTurns.has(permission.sessionId)) return CANCELLED_PERMISSION;
    let untrack = () => {};
    const cancelled = new Promise<RequestPermissionResponse>((resolve) => {
      untrack = track(permission.sessionId, () =>
        resolve(CANCELLED_PERMISSION),
      );
    });
    const answered = handler(permission).catch(() => CANCELLED_PERMISSION);
    try {
      return await Promise.race([answered, cancelled]);
    } finally {
      untrack();
    }
  };

  const beginTurn = (sessionId: SessionId) => {
    cancelledTurns.delete(sessionId);
  };

  const cancelTurn = (sessionId: SessionId) => {
    cancelledTurns.add(sessionId);
    settleSession(sessionId);
  };

  const cancelAll = () => {
    [...pending.keys()].forEach(settleSession);
  };

  return { request, beginTurn, cancelTurn, cancelAll };
};
