import type { Agent } from '../agents/index.js';
import type { BuilderTicket } from './tickets.js';

export interface AssignmentPromptParts {
  builder: Pick<Agent, 'name'>;
  ticket: Pick<BuilderTicket, 'id' | 'title' | 'body' | 'prUrl' | 'headSha'>;
  worktreePath: string;
  repoPath: string;
  base: string;
}

const openPullRequest = (ticket: AssignmentPromptParts['ticket']): string[] => {
  if (ticket.prUrl === null) return [];
  const head = ticket.headSha ?? 'unknown';
  return [
    `A pull request for this ticket is already open: ${ticket.prUrl} (head ${head}). Its builder was retired; check out its branch and carry it on.`,
  ];
};

export const buildAssignmentPrompt = (parts: AssignmentPromptParts): string =>
  [
    `You are ${parts.builder.name}, a builder on this project.`,
    `# Ticket ${parts.ticket.id}: ${parts.ticket.title}`,
    parts.ticket.body.trim() || 'The ticket has no body.',
    '# Where to work',
    `Work in ${parts.worktreePath}, your git worktree of ${parts.repoPath}, detached at ${parts.base}. Create a branch there, commit, push and open a pull request. Never touch ${parts.repoPath} itself.`,
    ...openPullRequest(parts.ticket),
    '# When you are done',
    `Call the bus tool \`report\` with ticket \`${parts.ticket.id}\`, the pull request URL, its head commit and what you tested. If you need a decision only a person can make, call \`ask\`. Use \`status\` for a one-line progress note.`,
  ].join('\n\n');
