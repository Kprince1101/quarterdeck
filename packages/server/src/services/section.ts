import {
  NO_TRACKER,
  forgeTerms,
  type Tracker,
  type TrackerHow,
} from '@quarterdeck/rules';
import { detectProjectForge, type DetectedForge } from '../gate/index.js';
import type { Store } from '../store/index.js';
import { loadServices, type ServicesOptions } from './resolve.js';

export interface PromptServices {
  forge: DetectedForge;
  tracker: Tracker | null;
}

export const SERVICES_HEADING = '## Services';

export const SERVICES_DIRECT =
  'Use these tools yourself. Quarterdeck never calls the tracker for you.';

export const promptServices = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: ServicesOptions = {},
): Promise<PromptServices> => {
  const [forge, services] = await Promise.all([
    detectProjectForge(store, options),
    loadServices(store, options),
  ]);
  return { forge, tracker: services.tracker };
};

const forgeLine = ({ forge, host }: DetectedForge): string => {
  const terms = forgeTerms(forge);
  let where: string = terms.name;
  if (host !== null) where = `${terms.name} at ${host}`;
  return `- Forge: ${where}. Use the \`${terms.cli}\` CLI for ${terms.long}s, reviews and checks.`;
};

const TRACKER_REACH: Record<TrackerHow, (tracker: Tracker) => string> = {
  cli: (tracker) => `, reached with the \`${tracker.command ?? ''}\` CLI`,
  mcp: (tracker) =>
    `, reached through the \`${tracker.server ?? ''}\` MCP server`,
};

const reachOf = (tracker: Tracker): string => {
  if (tracker.how === undefined) return '';
  return TRACKER_REACH[tracker.how](tracker);
};

const notesOf = (tracker: Tracker): string => {
  if (tracker.notes === undefined || tracker.notes === '') return '';
  return ` Notes: ${tracker.notes}`;
};

const trackerLine = (tracker: Tracker | null): string => {
  if (tracker === null || tracker.kind === NO_TRACKER)
    return '- Tracker: none.';
  return `- Tracker: ${tracker.kind}${reachOf(tracker)}.${notesOf(tracker)}`;
};

const externalRefLine = (externalRef: string | null): string[] => {
  if (externalRef === null) return [];
  return [`- This ticket in the tracker: ${externalRef}`];
};

export const servicesSection = (
  services: PromptServices,
  externalRef: string | null = null,
): string =>
  [
    SERVICES_HEADING,
    forgeLine(services.forge),
    trackerLine(services.tracker),
    ...externalRefLine(externalRef),
    SERVICES_DIRECT,
  ].join('\n');
