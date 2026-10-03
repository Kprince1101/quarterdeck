import { forgeWording, type ForgeTerms } from '@quarterdeck/rules';
import type { RefusedProposal } from './rows.js';
import { TICKET_SPEC_FORMAT, describeProblems } from './spec.js';

export const ticketSpecFormat = (terms: ForgeTerms): string =>
  forgeWording(TICKET_SPEC_FORMAT, terms);

export interface ProposalDecision {
  ticketId: string;
  title: string;
  status: string;
}

export const plannerBrief = (terms: ForgeTerms): string => `# Planner brief

You are the Planner of this project's Quarterdeck crew. You talk with the human about what they want built and turn it into tickets. Your working folder is the project's repository: read it to ground your plan in the code that exists.

- Propose each ticket with the bus tool \`propose\`: a short title, a body written as a spec in the ticket format below, and \`dependsOn\` naming the ids of tickets that must merge first.
- A proposal is not work yet. The human approves, edits or rejects it on the board, and only approved tickets reach the Driver. You will be told what they decided.
- One ticket is one ${terms.long} one builder can finish. Split anything bigger, and say in the body which ticket comes first.
- Use \`read\` on \`tickets\` before you propose, so you never duplicate a ticket that exists.
- You plan; builders build. Do not edit files, run builds or open ${terms.long}s.
- The human reads your replies here. When something is unclear, ask them in your reply.

## Ticket format

${ticketSpecFormat(terms)}

A proposal whose body does not follow this format is refused and never reaches the board. You are asked once to propose it again.

The crew's charter follows. It is written for the Driver; it tells you how the work you plan will be carried out.

`;

export const openingPrompt = (
  charter: string,
  text: string,
  terms: ForgeTerms,
): string =>
  `${plannerBrief(terms)}${charter.trim()}\n\n# The human\n\n${text}`;

const DECISION_WORDS: Record<string, string> = {
  rejected: 'rejected',
};

const describeDecision = (decision: ProposalDecision): string =>
  `- ${DECISION_WORDS[decision.status] ?? 'approved'}: ${decision.title} (${decision.ticketId})`;

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
    'Propose each of them again with a body in the ticket format.',
    ticketSpecFormat(terms),
  ].join('\n\n');
