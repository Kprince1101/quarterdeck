import { z } from 'zod';
import { PR_URL_MAX } from '../bus/review.js';
import { getErrorMessage } from '../lib/errors.js';
import { TicketSourceError, TicketSourceInputError } from './errors.js';

export const TICKET_STATUSES = [
  'proposed',
  'open',
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
  'done',
  'cancelled',
  'rejected',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_REF_MAX = 200;
export const TICKET_NOTE_MAX = 8000;

export interface ApprovedTicket {
  ref: string;
  title: string;
  body: string;
}

export interface TicketPullRequest {
  url: string;
  head: string | null;
}

export interface TicketSource {
  readonly name: string;
  listApproved: () => Promise<ApprovedTicket[]>;
  setStatus: (ref: string, status: TicketStatus) => Promise<void>;
  note: (ref: string, body: string) => Promise<void>;
  attachPr: (ref: string, pr: TicketPullRequest) => Promise<void>;
}

export type TicketSourceMethods = Omit<TicketSource, 'name'>;

const refSchema = z.string().min(1).max(TICKET_REF_MAX);

const pullRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(PR_URL_MAX),
  head: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'head must be a 40-character lowercase commit sha')
    .nullable(),
});

const approvedListSchema = z
  .array(
    z.object({
      ref: refSchema,
      title: z.string().trim().min(1),
      body: z.string().default(''),
    }),
  )
  .superRefine((tickets, ctx) => {
    const seen = new Set<string>();
    for (const [index, ticket] of tickets.entries()) {
      if (seen.has(ticket.ref))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'ref'],
          message: `ref ${ticket.ref} is listed twice`,
        });
      seen.add(ticket.ref);
    }
  });

const inputSchemas = {
  setStatus: z.object({ ref: refSchema, status: z.enum(TICKET_STATUSES) }),
  note: z.object({
    ref: refSchema,
    body: z.string().trim().min(1).max(TICKET_NOTE_MAX),
  }),
  attachPr: z.object({ ref: refSchema, pr: pullRequestSchema }),
};

const parseInput = <T>(
  source: string,
  operation: string,
  schema: z.ZodType<T>,
  input: unknown,
): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new TicketSourceInputError(
      source,
      operation,
      z.prettifyError(parsed.error),
    );
  return parsed.data;
};

export const checkedSource = (source: TicketSource): TicketSource => {
  const { name } = source;
  return {
    name,
    listApproved: () => source.listApproved(),
    setStatus: async (ref, status) => {
      const input = parseInput(name, 'setStatus', inputSchemas.setStatus, {
        ref,
        status,
      });
      await source.setStatus(input.ref, input.status);
    },
    note: async (ref, body) => {
      const input = parseInput(name, 'note', inputSchemas.note, { ref, body });
      await source.note(input.ref, input.body);
    },
    attachPr: async (ref, pr) => {
      const input = parseInput(name, 'attachPr', inputSchemas.attachPr, {
        ref,
        pr,
      });
      await source.attachPr(input.ref, input.pr);
    },
  };
};

export const pluginSource = (
  name: string,
  methods: TicketSourceMethods,
): TicketSource => {
  const call = async <T>(operation: string, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (err) {
      throw new TicketSourceError(name, operation, getErrorMessage(err), {
        cause: err,
      });
    }
  };
  return checkedSource({
    name,
    listApproved: async () => {
      const listed: unknown = await call('listApproved', () =>
        methods.listApproved(),
      );
      const parsed = approvedListSchema.safeParse(listed);
      if (!parsed.success)
        throw new TicketSourceError(
          name,
          'listApproved',
          `it returned tickets that do not match their shape:\n${z.prettifyError(parsed.error)}`,
        );
      return parsed.data;
    },
    setStatus: (ref, status) =>
      call('setStatus', () => methods.setStatus(ref, status)),
    note: (ref, body) => call('note', () => methods.note(ref, body)),
    attachPr: (ref, pr) => call('attachPr', () => methods.attachPr(ref, pr)),
  });
};
