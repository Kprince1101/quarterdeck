import { z } from 'zod';
import { publishEvent } from '../../store/index.js';
import {
  PR_URL_MAX,
  liveReviewer,
  lockTicket,
  notesSchema,
  ticketIdSchema,
} from '../review.js';
import { BusToolError, defineBusTool } from '../tool.js';

const REPORTABLE: readonly string[] = [
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
];

export default defineBusTool({
  description: [
    'Report the pull request for a ticket assigned to you. The ticket moves to in_review and is handed to the reviewer.',
    'Report again after pushing new commits; that withdraws any verdict given on the earlier ones.',
  ].join(' '),
  input: {
    ticket: ticketIdSchema.describe('The ticket id.'),
    pr: z
      .url({ protocol: /^https?$/ })
      .max(PR_URL_MAX)
      .describe('The pull request URL.'),
    notes: notesSchema.describe(
      'What the pull request does and how it was tested.',
    ),
    head: z
      .string()
      .regex(
        /^[0-9a-f]{40}$/,
        'head must be a 40-character lowercase commit sha',
      )
      .optional()
      .describe('The pull request head commit, 40 hex characters.'),
  },
  run: ({ store, agentId }, { ticket, pr, notes, head = null }) =>
    store.db.transaction(async (tx) => {
      const row = await lockTicket(tx, store.projectId, ticket);
      if (row.assigneeId !== agentId)
        throw new BusToolError(`ticket ${ticket} is not assigned to you`);
      if (!REPORTABLE.includes(row.status))
        throw new BusToolError(
          `ticket ${ticket} is ${row.status}; only an assigned, in_progress, in_review or bounced ticket can be reported`,
        );
      await tx.query(
        `update tickets set status = 'in_review', pr_url = $2, head_sha = $3
         where id = $1`,
        [ticket, pr, head],
      );
      const reviewer = await liveReviewer(tx, store.projectId);
      await publishEvent(tx, store.projectId, {
        kind: 'ticket.reported',
        agentId,
        ticketId: ticket,
        payload: { pr, head, notes, reviewerId: reviewer?.id ?? null },
      });
      if (reviewer === undefined)
        return `ticket ${ticket} is in review; the project has no live reviewer yet, so it waits for one`;
      return `ticket ${ticket} is in review; handed to ${reviewer.name}`;
    }),
});
