import { z } from 'zod';
import {
  changesSomething,
  hasUniqueValues,
  idSchema,
  inProject,
  optionalTextSchema,
  textSchema,
  titleSchema,
} from './fields.js';

const MAX_DEPENDENCIES = 50;

const dependsOnSchema = z
  .array(idSchema)
  .max(MAX_DEPENDENCIES)
  .refine(hasUniqueValues, 'dependsOn must not repeat a ticket');

const TICKET_FIELDS = ['title', 'body', 'dependsOn'] as const;

export const BOARD_INTENTS = {
  'card.answer': inProject({ cardId: idSchema, answer: textSchema }),
  'card.decline': inProject({ cardId: idSchema }),
  'notebook.add': inProject({
    body: textSchema,
    pinned: z.boolean().default(false),
  }),
  'notebook.pin': inProject({ entryId: idSchema, pinned: z.boolean() }),
  'notebook.remove': inProject({ entryId: idSchema }),
  'charter.decide': inProject({
    proposalId: idSchema,
    decision: z.enum(['accepted', 'rejected']),
  }),
  'ticket.create': inProject({
    title: titleSchema,
    body: optionalTextSchema.default(''),
    dependsOn: dependsOnSchema.default([]),
  }),
  'ticket.update': inProject({
    ticketId: idSchema,
    title: titleSchema.optional(),
    body: optionalTextSchema.optional(),
    dependsOn: dependsOnSchema.optional(),
  }).refine(
    (input) => changesSomething(input, TICKET_FIELDS),
    'ticket.update needs title, body or dependsOn',
  ),
  'ticket.cancel': inProject({ ticketId: idSchema }),
  'ticket.approve': inProject({
    ticketId: idSchema,
    title: titleSchema.optional(),
    body: optionalTextSchema.optional(),
    dependsOn: dependsOnSchema.optional(),
  }),
  'ticket.reject': inProject({ ticketId: idSchema }),
};

export type BoardIntentName = keyof typeof BOARD_INTENTS;
