import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  QUARTERDECK_COMMAND,
  createProjectStores,
  dispatchIntent,
  quarterdeckHome,
  type ProjectStores,
} from '@quarterdeck/server';
import {
  WIPE_ALL_CONFIRMATION,
  projectSlugSchema,
  wipeResultSchema,
  type IntentReply,
  type WipeResult,
} from '@quarterdeck/server/intents';
import { parseIntent } from './intent.js';
import { CliError, type CliIo, type Command } from './io.js';

export const WIPE_USAGE = `Usage: ${QUARTERDECK_COMMAND} wipe <project> [--confirm <project>]
       ${QUARTERDECK_COMMAND} wipe --all [--confirm "${WIPE_ALL_CONFIRMATION}"]

Stops the project's agents, then deletes everything Quarterdeck stores for it,
as the dashboard's Wipe button does. You are asked to type the project slug
(or "${WIPE_ALL_CONFIRMATION}" with --all) before anything is deleted.

  --all               Wipe every project on this machine
  --confirm <phrase>  The phrase you would type, for scripts without a terminal`;

interface WipeTarget {
  phrase: string;
  warning: string;
  send: (io: CliIo) => Promise<IntentReply>;
}

const quoted = (phrase: string): string => {
  if (/\s/.test(phrase)) return JSON.stringify(phrase);
  return phrase;
};

const listOf = (items: readonly string[]): string => {
  if (items.length === 0) return 'nothing';
  return items.join(', ');
};

const wipeSummary = ({ wiped, stopped }: WipeResult): string => {
  const summary = `Wiped ${listOf(wiped)}.`;
  if (stopped.length === 0) return summary;
  const agents = stopped.map(({ project, agent }) => `${agent} (${project})`);
  return `${summary} Stopped ${listOf(agents)} first.`;
};

const projectData = (stores: ProjectStores, project: string): string => {
  if (stores.location === stores.dataHome) {
    return join(stores.dataHome, project);
  }
  return stores.location;
};

const projectTarget = async (
  stores: ProjectStores,
  project: string,
): Promise<WipeTarget> => {
  if (!projectSlugSchema.safeParse(project).success) {
    throw new CliError(`${JSON.stringify(project)} is not a project slug`);
  }
  if (!(await stores.list()).includes(project)) {
    throw new CliError(
      `project ${project} does not exist in ${stores.location}`,
    );
  }
  return {
    phrase: project,
    warning: `This stops ${project}'s agents and deletes everything Quarterdeck stores for it in ${projectData(stores, project)}.`,
    send: (io) =>
      dispatchIntent(
        { stores, homeDir: io.homeDir },
        'wipe.project',
        parseIntent('wipe.project', { project, confirm: project }),
      ),
  };
};

const allTarget = (
  stores: ProjectStores,
  projects: readonly string[],
): WipeTarget => ({
  phrase: WIPE_ALL_CONFIRMATION,
  warning: `This stops every agent and deletes every project in ${stores.location}: ${listOf(projects)}.`,
  send: (io) =>
    dispatchIntent(
      { stores, homeDir: io.homeDir },
      'wipe.all',
      parseIntent('wipe.all', { confirm: WIPE_ALL_CONFIRMATION }),
    ),
});

const confirmation = async (
  target: WipeTarget,
  flag: string | undefined,
  io: CliIo,
): Promise<string> => {
  if (flag !== undefined) return flag;
  if (!io.prompter) {
    throw new CliError(
      `Nothing wiped. Without a terminal, pass --confirm ${quoted(target.phrase)}.`,
    );
  }
  io.out(target.warning);
  return (
    await io.prompter.ask(`Type ${quoted(target.phrase)} to wipe: `)
  ).trim();
};

const wipe = async (
  target: WipeTarget,
  flag: string | undefined,
  io: CliIo,
): Promise<number> => {
  const typed = await confirmation(target, flag, io);
  if (typed !== target.phrase) {
    throw new CliError(
      `Nothing wiped: the confirmation must be ${quoted(target.phrase)}.`,
    );
  }
  const reply = await target.send(io);
  io.out(wipeSummary(wipeResultSchema.parse(reply.result)));
  return 0;
};

export const runWipe: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      confirm: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.out(WIPE_USAGE);
    return 0;
  }
  const [project, ...extra] = positionals;
  if (extra.length > 0) throw new CliError('wipe takes one project');
  if (values.all && project !== undefined) {
    throw new CliError('Pass a project or --all, not both');
  }
  if (!values.all && project === undefined) {
    throw new CliError(`wipe needs a project or --all\n\n${WIPE_USAGE}`);
  }
  const stores = createProjectStores(quarterdeckHome(io.homeDir));
  try {
    if (project !== undefined) {
      const target = await projectTarget(stores, project);
      return await wipe(target, values.confirm, io);
    }
    const projects = await stores.list();
    if (projects.length === 0) {
      io.out(`Nothing to wipe in ${stores.location}.`);
      return 0;
    }
    return await wipe(allTarget(stores, projects), values.confirm, io);
  } finally {
    await stores.closeAll();
  }
};
