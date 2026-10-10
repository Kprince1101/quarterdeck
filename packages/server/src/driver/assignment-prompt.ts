import type { ForgeTerms } from '@quarterdeck/rules';
import type { Agent } from '../agents/index.js';
import { servicesSection, type PromptServices } from '../services/index.js';
import type { WorkspaceMode } from '../stream/schema.js';
import type { BuilderTicket } from './tickets.js';

export interface AssignmentPromptParts {
  builder: Pick<Agent, 'name'>;
  ticket: Pick<
    BuilderTicket,
    'id' | 'title' | 'body' | 'prUrl' | 'headSha' | 'externalRef'
  >;
  worktreePath: string;
  repoPath: string;
  base: string;
  terms: ForgeTerms;
  services: PromptServices;
  mode?: WorkspaceMode | undefined;
}

const SPEC_INSTRUCTION =
  "Work the ticket's `## Tasks` list in order, one task at a time. Before you report, prove its `Proven:` line: run or show the check it names.";

const openPullRequest = (parts: AssignmentPromptParts): string[] => {
  const { ticket, terms } = parts;
  if (ticket.prUrl === null) return [];
  const head = ticket.headSha ?? 'unknown';
  return [
    `A ${terms.long} for this ticket is already open: ${ticket.prUrl} (head ${head}). Its builder was retired; check out its branch and carry it on.`,
  ];
};

const BUILDER_ON: Record<WorkspaceMode, string> = {
  multi: 'this project',
  single: 'this repository',
};

export const buildAssignmentPrompt = (parts: AssignmentPromptParts): string =>
  [
    `You are ${parts.builder.name}, a builder on ${BUILDER_ON[parts.mode ?? 'multi']}.`,
    `# Ticket ${parts.ticket.id}: ${parts.ticket.title}`,
    parts.ticket.body.trim() || 'The ticket has no body.',
    SPEC_INSTRUCTION,
    '# Where to work',
    `Work in ${parts.worktreePath}, your git worktree of ${parts.repoPath}, detached at ${parts.base}. Create a branch there, commit, push and open a ${parts.terms.long}. Never touch ${parts.repoPath} itself.`,
    ...openPullRequest(parts),
    servicesSection(parts.services, parts.ticket.externalRef),
    '# When you are done',
    `Call the bus tool \`report\` with ticket \`${parts.ticket.id}\`, the ${parts.terms.long} URL, its head commit and what you tested. If you need a decision only a person can make, call \`ask\`. Use \`status\` for a one-line progress note.`,
  ].join('\n\n');
