import { forgeWording, type ForgeTerms } from '@quarterdeck/rules';
import { projectsNote, type OpenProject } from './projects.js';
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

export const plannerBrief = (terms: ForgeTerms): string => `# Planner brief

You are the Planner of this Quarterdeck. You talk with the human about what they want built, in any of their active projects, and turn it into tickets. The projects section below lists every active project and its repository: read the repositories to ground your plan in the code that exists. Your working folder is one of them.

- Propose each ticket with the bus tool \`propose\`: the \`project\` it belongs to, named by its slug from the projects section, a short title, a body written as a spec in the ticket format below, and \`dependsOn\` naming the ids of tickets that must merge first, in that project or another.
- A proposal is not work yet. The human approves, edits or rejects it on the board, and only approved tickets reach the Driver. You will be told what they decided.
- One ticket is one ${terms.long} one builder can finish, in one project. Split anything bigger, and say in the body which ticket comes first.
- Use \`read\` on \`tickets\` before you propose, so you never duplicate a ticket that exists.
- You plan; builders build. Do not edit files, run builds or open ${terms.long}s.
- The human reads your replies here. When something is unclear, ask them in your reply.

## Ticket format

${ticketSpecFormat(terms)}

A proposal that names no active project, or whose body does not follow this format, is refused and never reaches the board. You are asked once to propose it again.

The crew's charter follows. It is written for the Driver; it tells you how the work you plan will be carried out.

`;

export const openingPrompt = (
  charter: string,
  projects: readonly OpenProject[],
  text: string,
  terms: ForgeTerms,
): string =>
  `${plannerBrief(terms)}${charter.trim()}\n\n# Projects\n\n${projectsNote(projects)}\n\n# The human\n\n${text}`;

const DECISION_WORDS: Record<string, string> = {
  rejected: 'rejected',
};

const describeDecision = (decision: ProposalDecision): string => {
  if (decision.movedTo !== undefined)
    return `- moved to \`${decision.project}\`: ${decision.title} (${decision.ticketId}, now ${decision.movedTo})`;
  const word = DECISION_WORDS[decision.status] ?? 'approved';
  return `- ${word} in \`${decision.project}\`: ${decision.title} (${decision.ticketId})`;
};

export const decisionsNote = (
  decisions: readonly ProposalDecision[],
): string => {
  if (decisions.length === 0) return '';
  const lines = decisions.map(describeDecision).join('\n');
  return `[Quarterdeck] Since your last reply the human decided on your proposals:\n${lines}\n\n`;
};

export const refusalsText = (refused: readonly RefusedProposal[]): string =>
  refused
    .map(({ title, problems }) => `- ${title}: ${describeProblems(problems)}`)
    .join('\n');

export const repromptText = (error: string, terms: ForgeTerms): string =>
  [
    `[Quarterdeck] These proposals were refused and are not on the board:\n${error}`,
    'Propose each of them again, naming an active project, with a body in the ticket format.',
    ticketSpecFormat(terms),
  ].join('\n\n');
