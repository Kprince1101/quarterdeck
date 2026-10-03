import {
  NO_TRACKER,
  forgeTerms,
  type Forge,
  type Tracker,
  type TrackerHow,
} from '@quarterdeck/rules';
import { detectProjectForge, type DetectedForge } from '../gate/index.js';
import type { Queryable, Store } from '../store/index.js';
import { loadServices, type ServicesOptions } from './resolve.js';

export interface PromptServices {
  forge: DetectedForge;
  tracker: Tracker | null;
}

export const SERVICES_HEADING = '# Services';

export const SERVICES_DIRECT =
  'Use these tools yourself. Quarterdeck never calls the tracker for you.';

export interface PromptServicesOptions extends ServicesOptions {
  forge?: (() => Promise<Forge>) | undefined;
}

const forgeOf = async (
  detected: DetectedForge,
  forge: (() => Promise<Forge>) | undefined,
): Promise<DetectedForge> => {
  if (forge === undefined) return detected;
  return { forge: await forge(), host: detected.host };
};

export const promptServices = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: PromptServicesOptions = {},
): Promise<PromptServices> => {
  const [detected, services] = await Promise.all([
    detectProjectForge(store, { homeDir: options.homeDir }),
    loadServices(store, { homeDir: options.homeDir }),
  ]);
  return {
    forge: await forgeOf(detected, options.forge),
    tracker: services.tracker,
  };
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

export const servicesLines = (
  services: PromptServices,
  externalRef: string | null = null,
): string =>
  [
    forgeLine(services.forge),
    trackerLine(services.tracker),
    ...externalRefLine(externalRef),
    SERVICES_DIRECT,
  ].join('\n');

export const servicesSection = (
  services: PromptServices,
  externalRef: string | null = null,
): string => `${SERVICES_HEADING}\n\n${servicesLines(services, externalRef)}`;

export const ticketExternalRef = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
): Promise<string | null> => {
  const { rows } = await db.query<{ externalRef: string | null }>(
    `select external_ref as "externalRef" from tickets
     where id = $1 and project_id = $2`,
    [ticketId, projectId],
  );
  return rows[0]?.externalRef ?? null;
};
