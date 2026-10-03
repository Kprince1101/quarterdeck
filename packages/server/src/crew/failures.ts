import { getErrorMessage } from '../lib/errors.js';
import type { PublishInput, Store } from '../store/index.js';

export const CREW_FAILED_EVENT = 'crew.failed';

export type CrewService =
  | 'start'
  | 'planner'
  | 'intents'
  | 'archive'
  | 'gate'
  | 'reviewer'
  | 'voyages'
  | 'driver'
  | 'builder';

export interface CrewFailureLinks {
  voyageId?: string;
  agentId?: string;
  ticketId?: string;
}

export type CrewFailureReporter = (
  service: CrewService,
  links?: CrewFailureLinks,
) => (err: unknown) => void;

export const crewFailedEvent = (
  service: CrewService,
  err: unknown,
  links: CrewFailureLinks = {},
): PublishInput => {
  const event: PublishInput = {
    kind: CREW_FAILED_EVENT,
    payload: {
      service,
      error: getErrorMessage(err),
      voyageId: links.voyageId ?? null,
    },
  };
  if (links.agentId !== undefined) event.agentId = links.agentId;
  if (links.ticketId !== undefined) event.ticketId = links.ticketId;
  return event;
};

export class AgentExitedError extends Error {
  constructor(agent: { name: string }) {
    super(`${agent.name}'s process exited`);
    this.name = 'AgentExitedError';
  }
}

export class CrewStoppedError extends Error {
  constructor() {
    super("the project's crew is stopping");
    this.name = 'CrewStoppedError';
  }
}

export const crewFailureReporter =
  (
    store: Pick<Store, 'publish'>,
    log: (err: unknown) => void,
  ): CrewFailureReporter =>
  (service, links = {}) =>
  (err) => {
    if (err instanceof CrewStoppedError) return;
    log(err);
    store.publish(crewFailedEvent(service, err, links)).catch(log);
  };

export interface FailureTarget {
  store: Pick<Store, 'publish'>;
  links: CrewFailureLinks;
}

export const reportToEach = (
  targets: readonly FailureTarget[],
  service: CrewService,
  log: (err: unknown) => void,
): ((err: unknown) => void) => {
  const reports = targets.map(({ store, links }) =>
    crewFailureReporter(store, () => undefined)(service, links),
  );
  return (err) => {
    if (err instanceof CrewStoppedError) return;
    log(err);
    for (const report of reports) report(err);
  };
};
