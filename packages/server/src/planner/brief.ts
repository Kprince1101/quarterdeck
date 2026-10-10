import { forgeWording, type ForgeTerms } from '@quarterdeck/rules';
import type { WorkspaceMode } from '../stream/schema.js';
import {
  multiOnly,
  singleOnly,
  workspaceWording,
} from '../workspace/wording.js';
import { projectsNote, repoLine, type OpenProject } from './projects.js';
import type { RefusedProposal } from './rows.js';
import { TICKET_SPEC_FORMAT, describeProblems } from './spec.js';

export const ticketSpecFormat = (terms: ForgeTerms): string =>
  forgeWording(TICKET_SPEC_FORMAT, terms);

export interface ProposalDecision {
  ticketId: string;
  title: string;
  status: string;
  project: string;
  movedTo?: string;
}

const briefTemplate = (terms: ForgeTerms): string => `# Planner brief

${multiOnly('You are the Planner of this Quarterdeck. You talk with the human about what they want built, in any of their active projects, and turn it into tickets. The projects section below lists every active project and its repository: read the repositories to ground your plan in the code that exists. Your working folder is one of them.')}
${singleOnly('You are the Planner of this Quarterdeck. You talk with the human about what they want built in this repository, and turn it into tickets. Your working folder is the repository: read it to ground your plan in the code that exists.')}

${multiOnly('- Propose each ticket with the bus tool `propose`: the `project` it belongs to, named by its slug from the projects section, a short title, a body written as a spec in the ticket format below, and `dependsOn` naming the ids of tickets that must merge first, in that project or another.')}
${singleOnly('- Propose each ticket with the bus tool `propose`: a short title, a body written as a spec in the ticket format below, and `dependsOn` naming the ids of tickets that must merge first.')}
- A proposal is not work yet. The human approves, edits or rejects it on the board, and only approved tickets reach the Driver. You will be told what they decided.
${multiOnly(`- One ticket is one ${terms.long} one builder can finish, in one project. Split anything bigger, and say in the body which ticket comes first.`)}
${singleOnly(`- One ticket is one ${terms.long} one builder can finish. Split anything bigger, and say in the body which ticket comes first.`)}
- Use \`read\` on \`tickets\` before you propose, so you never duplicate a ticket that exists.
- You plan; builders build. Do not edit files, run builds or open ${terms.long}s.
- The human reads your replies here. When something is unclear, ask them in your reply.

## Ticket format

${ticketSpecFormat(terms)}

${multiOnly('A proposal that names no active project, or whose body does not follow this format, is refused and never reaches the board. You are asked once to propose it again.')}
${singleOnly('A proposal whose body does not follow this format is refused and never reaches the board. You are asked once to propose it again.')}

The crew's charter follows. It is written for the Driver; it tells you how the work you plan will be carried out.

`;

export const plannerBrief = (
  terms: ForgeTerms,
  mode: WorkspaceMode = 'multi',
): string => `${workspaceWording(briefTemplate(terms), mode)}\n\n`;

const workSection = (
  projects: readonly OpenProject[],
  mode: WorkspaceMode,
): string => {
  if (mode === 'multi') return `# Projects\n\n${projectsNote(projects)}`;
  const repos = projects.map(({ repoPath }) => repoLine(repoPath));
  return `# Repository\n\n${repos.join('\n')}`;
};

export const openingPrompt = (
  charter: string,
  projects: readonly OpenProject[],
  text: string,
  terms: ForgeTerms,
  mode: WorkspaceMode = 'multi',
): string =>
  `${plannerBrief(terms, mode)}${charter.trim()}\n\n${workSection(projects, mode)}\n\n# The human\n\n${text}`;

const DECISION_WORDS: Record<string, string> = {
  rejected: 'rejected',
};

const describeDecision = (
  decision: ProposalDecision,
  mode: WorkspaceMode,
): string => {
  const word = DECISION_WORDS[decision.status] ?? 'approved';
  if (mode === 'single')
    return `- ${word}: ${decision.title} (${decision.ticketId})`;
  if (decision.movedTo !== undefined)
    return `- moved to \`${decision.project}\`: ${decision.title} (${decision.ticketId}, now ${decision.movedTo})`;
  return `- ${word} in \`${decision.project}\`: ${decision.title} (${decision.ticketId})`;
};

export const decisionsNote = (
  decisions: readonly ProposalDecision[],
  mode: WorkspaceMode = 'multi',
): string => {
  if (decisions.length === 0) return '';
  const lines = decisions
    .map((decision) => describeDecision(decision, mode))
    .join('\n');
  return `[Quarterdeck] Since your last reply the human decided on your proposals:\n${lines}\n\n`;
};

export const refusalsText = (refused: readonly RefusedProposal[]): string =>
  refused
    .map(({ title, problems }) => `- ${title}: ${describeProblems(problems)}`)
    .join('\n');

const AGAIN: Record<WorkspaceMode, string> = {
  multi:
    'Propose each of them again, naming an active project, with a body in the ticket format.',
  single: 'Propose each of them again, with a body in the ticket format.',
};

export const repromptText = (
  error: string,
  terms: ForgeTerms,
  mode: WorkspaceMode = 'multi',
): string =>
  [
    `[Quarterdeck] These proposals were refused and are not on the board:\n${error}`,
    AGAIN[mode],
    ticketSpecFormat(terms),
  ].join('\n\n');
