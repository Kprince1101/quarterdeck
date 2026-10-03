import type { AgentLifecycle } from '../agents/index.js';
import type { Store } from '../store/index.js';
import { startAutoEnd, type AutoEnd, type AutoEndOptions } from './auto-end.js';
import {
  cleanUpVoyage,
  releaseVoyage,
  type CleanUpOptions,
  type VoyageCleanup,
  type VoyageRelease,
} from './cleanup.js';
import {
  NO_DRIVER_SESSION,
  missWrapUp,
  wrapUpVoyage,
  type WrapUp,
  type WrapUpOptions,
} from './wrap-up.js';

export const SETTLED_REASON = 'settled';
export const ENDED_REASON = 'ended';
export const KILLED_REASON = 'killed';

export interface EndVoyageOptions extends WrapUpOptions {
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  reason?: string;
}

export interface EndedVoyage {
  wrapUp: WrapUp;
  cleanup: VoyageCleanup;
}

export interface VoyageStepOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  voyageId: string;
}

const withRelease = (
  released: VoyageRelease,
  cleanup: VoyageCleanup,
): VoyageCleanup => ({
  ...cleanup,
  closedCards: [...released.closedCards, ...cleanup.closedCards],
  retired: [...released.retired, ...cleanup.retired],
  discardCards: [...released.discardCards, ...cleanup.discardCards],
});

const endWith = async (
  options: CleanUpOptions,
  wrapUp: () => Promise<WrapUp>,
): Promise<EndedVoyage> => {
  const released = await releaseVoyage(options);
  const wrapped = await wrapUp();
  const cleanup = await cleanUpVoyage(options);
  return { wrapUp: wrapped, cleanup: withRelease(released, cleanup) };
};

export const endVoyage = (options: EndVoyageOptions): Promise<EndedVoyage> =>
  endWith(
    {
      store: options.store,
      lifecycle: options.lifecycle,
      voyageId: options.voyage.voyage.id,
      reason: options.reason ?? SETTLED_REASON,
    },
    () => wrapUpVoyage(options),
  );

export const endVoyageWithoutDriver = (
  options: VoyageStepOptions,
): Promise<EndedVoyage> =>
  endWith({ ...options, reason: ENDED_REASON }, () =>
    missWrapUp(options.store, options.voyageId, NO_DRIVER_SESSION),
  );

export const killVoyage = (
  options: VoyageStepOptions,
): Promise<VoyageCleanup> =>
  cleanUpVoyage({ ...options, reason: KILLED_REASON, reopen: true });

export interface VoyageAutoEndOptions
  extends
    EndVoyageOptions,
    Pick<AutoEndOptions, 'settleSeconds' | 'schedule' | 'home' | 'onError'> {
  onEnded?: (ended: EndedVoyage) => void;
}

export const startVoyageAutoEnd = (
  options: VoyageAutoEndOptions,
): Promise<AutoEnd> => {
  const { settleSeconds, schedule, home, onError, onEnded, ...end } = options;
  const auto: AutoEndOptions = {
    store: options.store,
    voyageId: options.voyage.voyage.id,
    settleSeconds,
    end: async () => {
      const ended = await endVoyage(end);
      onEnded?.(ended);
    },
  };
  if (schedule !== undefined) auto.schedule = schedule;
  if (home !== undefined) auto.home = home;
  if (onError !== undefined) auto.onError = onError;
  return startAutoEnd(auto);
};
