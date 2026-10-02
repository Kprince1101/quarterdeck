import { z } from 'zod';
import { publishEvent } from '../../store/index.js';
import {
  findCaller,
  isGone,
  lockTicket,
  notesSchema,
  ticketIdSchema,
} from '../review.js';
import { BusToolError, defineBusTool } from '../tool.js';

export default defineBusTool({
  description: [
    'Reviewer only: give your verdict on a ticket in review.',
    '`approve` when its pull request is ready to merge as it stands; the ticket stays in review for the merge gate.',
    '`changes` bounces the ticket back to its builder with your notes.',
  ].join(' '),
  input: {
    ticket: ticketIdSchema.describe('The ticket you reviewed.'),
    decision: z.enum(['approve', 'changes']),
    notes: notesSchema.describe(
      'Why. For changes, name each problem with file and line, why it matters and what would fix it.',
    ),
  },
  run: ({ store, agentId }, { ticket, decision, notes }) =>
    store.db.transaction(async (tx) => {
      const caller = await findCaller(tx, store.projectId, agentId);
      if (caller.role !== 'reviewer')
        throw new BusToolError(
          `only the reviewer gives a verdict; you are the ${caller.role} ${caller.name}`,
        );
      if (isGone(caller))
        throw new BusToolError(
          `you are ${caller.status} and can no longer give a verdict`,
        );
      const row = await lockTicket(tx, store.projectId, ticket);
      if (row.status !== 'in_review')
        throw new BusToolError(
          `ticket ${ticket} is ${row.status}, not in_review`,
        );
      if (row.assigneeId === agentId)
        throw new BusToolError(
          `ticket ${ticket} is assigned to you; you cannot review it`,
        );
      if (decision === 'changes')
        await tx.query(`update tickets set status = 'bounced' where id = $1`, [
          ticket,
        ]);
      await publishEvent(tx, store.projectId, {
        kind: 'ticket.verdict',
        agentId,
        ticketId: ticket,
        payload: { decision, notes, pr: row.prUrl, head: row.headSha },
      });
      if (decision === 'changes')
        return `ticket ${ticket} is bounced back to its builder`;
      return `approved ticket ${ticket}; it stays in review for the merge gate`;
    }),
});
