import type { AgentLifecycle } from '../agents/index.js';
import type { Store } from '../store/index.js';
import { startAutoEnd, type AutoEnd, type AutoEndOptions } from './auto-end.js';
import {
  cleanUpRound,
  releaseRound,
  type CleanUpOptions,
  type RoundCleanup,
  type RoundRelease,
} from './cleanup.js';
import {
  NO_DRIVER_SESSION,
  missWrapUp,
  wrapUpRound,
  type WrapUp,
  type WrapUpOptions,
} from './wrap-up.js';

export const SETTLED_REASON = 'settled';
export const ENDED_REASON = 'ended';
export const KILLED_REASON = 'killed';

export interface EndRoundOptions extends WrapUpOptions {
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  reason?: string;
}

export interface EndedRound {
  wrapUp: WrapUp;
  cleanup: RoundCleanup;
}

export interface RoundStepOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  roundId: string;
}

const withRelease = (
  released: RoundRelease,
  cleanup: RoundCleanup,
): RoundCleanup => ({
  ...cleanup,
  closedCards: [...released.closedCards, ...cleanup.closedCards],
  retired: [...released.retired, ...cleanup.retired],
  discardCards: [...released.discardCards, ...cleanup.discardCards],
});

const endWith = async (
  options: CleanUpOptions,
  wrapUp: () => Promise<WrapUp>,
): Promise<EndedRound> => {
  const released = await releaseRound(options);
  const wrapped = await wrapUp();
  const cleanup = await cleanUpRound(options);
  return { wrapUp: wrapped, cleanup: withRelease(released, cleanup) };
};

export const endRound = (options: EndRoundOptions): Promise<EndedRound> =>
  endWith(
    {
      store: options.store,
      lifecycle: options.lifecycle,
      roundId: options.round.round.id,
      reason: options.reason ?? SETTLED_REASON,
    },
    () => wrapUpRound(options),
  );

export const endRoundWithoutDriver = (
  options: RoundStepOptions,
): Promise<EndedRound> =>
  endWith({ ...options, reason: ENDED_REASON }, () =>
    missWrapUp(options.store, options.roundId, NO_DRIVER_SESSION),
  );

export const killRound = (options: RoundStepOptions): Promise<RoundCleanup> =>
  cleanUpRound({ ...options, reason: KILLED_REASON, reopen: true });

export interface RoundAutoEndOptions
  extends
    EndRoundOptions,
    Pick<AutoEndOptions, 'settleSeconds' | 'schedule' | 'home' | 'onError'> {
  onEnded?: (ended: EndedRound) => void;
}

export const startRoundAutoEnd = (
  options: RoundAutoEndOptions,
): Promise<AutoEnd> => {
  const { settleSeconds, schedule, home, onError, onEnded, ...end } = options;
  const auto: AutoEndOptions = {
    store: options.store,
    roundId: options.round.round.id,
    settleSeconds,
    end: async () => {
      const ended = await endRound(end);
      onEnded?.(ended);
    },
  };
  if (schedule !== undefined) auto.schedule = schedule;
  if (home !== undefined) auto.home = home;
  if (onError !== undefined) auto.onError = onError;
  return startAutoEnd(auto);
};
