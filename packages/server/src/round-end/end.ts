import type { AgentLifecycle } from '../agents/index.js';
import { startAutoEnd, type AutoEnd, type AutoEndOptions } from './auto-end.js';
import { cleanUpRound, type RoundCleanup } from './cleanup.js';
import { wrapUpRound, type WrapUp, type WrapUpOptions } from './wrap-up.js';

export const SETTLED_REASON = 'settled';

export interface EndRoundOptions extends WrapUpOptions {
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  reason?: string;
}

export interface EndedRound {
  wrapUp: WrapUp;
  cleanup: RoundCleanup;
}

export const endRound = async (
  options: EndRoundOptions,
): Promise<EndedRound> => {
  const wrapUp = await wrapUpRound(options);
  const cleanup = await cleanUpRound({
    store: options.store,
    lifecycle: options.lifecycle,
    roundId: options.round.round.id,
    reason: options.reason ?? SETTLED_REASON,
  });
  return { wrapUp, cleanup };
};

export interface RoundAutoEndOptions
  extends
    EndRoundOptions,
    Pick<AutoEndOptions, 'settleSeconds' | 'schedule' | 'onError'> {
  onEnded?: (ended: EndedRound) => void;
}

export const startRoundAutoEnd = (
  options: RoundAutoEndOptions,
): Promise<AutoEnd> => {
  const { settleSeconds, schedule, onError, onEnded, ...end } = options;
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
  if (onError !== undefined) auto.onError = onError;
  return startAutoEnd(auto);
};
