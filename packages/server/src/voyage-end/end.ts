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
  type WrapUpLeg,
  type WrapUpOptions,
} from './wrap-up.js';

export const SETTLED_REASON = 'settled';
export const ENDED_REASON = 'ended';
export const KILLED_REASON = 'killed';

export interface EndLeg extends WrapUpLeg {
  lifecycle: Pick<AgentLifecycle, 'retire'>;
}

export interface EndVoyageOptions extends WrapUpOptions {
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  reason?: string;
  legs?: readonly EndLeg[];
  closeDriver?: () => Promise<void>;
}

export interface LegCleanup extends VoyageCleanup {
  project: string;
}

export interface EndedVoyage {
  wrapUp: WrapUp;
  cleanup: VoyageCleanup;
  cleanups: LegCleanup[];
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

interface LegStep {
  project: string;
  options: CleanUpOptions;
}

const endWith = async (
  steps: readonly LegStep[],
  wrapUp: () => Promise<WrapUp>,
  closeDriver: () => Promise<void> = () => Promise.resolve(),
): Promise<EndedVoyage> => {
  const released: VoyageRelease[] = [];
  for (const step of steps) released.push(await releaseVoyage(step.options));
  const wrapped = await wrapUp();
  await closeDriver();
  const cleanups: LegCleanup[] = [];
  for (const [index, step] of steps.entries()) {
    const cleanup = await cleanUpVoyage(step.options);
    const release = released[index];
    if (release === undefined) continue;
    cleanups.push({ ...withRelease(release, cleanup), project: step.project });
  }
  const [cleanup] = cleanups;
  if (cleanup === undefined) throw new Error('the voyage has no projects');
  return { wrapUp: wrapped, cleanup, cleanups };
};

const endSteps = (options: EndVoyageOptions): LegStep[] => {
  const reason = options.reason ?? SETTLED_REASON;
  if (options.legs === undefined)
    return [
      {
        project: '',
        options: {
          store: options.store,
          lifecycle: options.lifecycle,
          voyageId: options.voyage.voyage.id,
          reason,
        },
      },
    ];
  return options.legs.map((leg) => ({
    project: leg.project,
    options: {
      store: leg.store,
      lifecycle: leg.lifecycle,
      voyageId: leg.voyageId,
      reason,
    },
  }));
};

export const endVoyage = (options: EndVoyageOptions): Promise<EndedVoyage> =>
  endWith(endSteps(options), () => wrapUpVoyage(options), options.closeDriver);

export const endVoyageWithoutDriver = (
  options: VoyageStepOptions,
): Promise<EndedVoyage> =>
  endWith(
    [{ project: '', options: { ...options, reason: ENDED_REASON } }],
    () => missWrapUp(options.store, options.voyageId, NO_DRIVER_SESSION),
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
  const legs = options.legs ?? [
    { store: options.store, voyageId: options.voyage.voyage.id },
  ];
  const auto: AutoEndOptions = {
    legs,
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
