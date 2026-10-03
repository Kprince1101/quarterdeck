import { upperFirst, type ForgeTerms } from '@quarterdeck/rules';

export interface ReviewRequest {
  ticket: { id: string; title: string; body: string };
  reviewer: { id: string; name: string };
  builder: { id: string; name: string } | null;
  pr: string;
  head: string | null;
  notes: string;
  terms: ForgeTerms;
}

export interface ReviewerHost {
  requestReview: (request: ReviewRequest) => Promise<void>;
}

export const reviewPrompt = (request: ReviewRequest): string => {
  const { ticket } = request;
  const lines = [`Review ticket ${ticket.id}: ${ticket.title}`];
  if (ticket.body.trim() !== '') lines.push('', ticket.body.trim());
  lines.push('', `${upperFirst(request.terms.long)}: ${request.pr}`);
  lines.push(`Head commit: ${request.head ?? 'not reported'}`);
  const from = request.builder?.name ?? 'the builder';
  lines.push('', `Notes from ${from}:`, request.notes);
  lines.push(
    '',
    `Give your verdict on ticket ${ticket.id} with the bus tool \`verdict\`.`,
  );
  return lines.join('\n');
};
