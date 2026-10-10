import { z } from 'zod';
import {
  EMPTY_MESSAGE_REFUSAL,
  attachmentUploadsSchema,
  hasTextOrAttachments,
  messageTextSchema,
} from './attachments.js';
import {
  idSchema,
  inProject,
  optionalTextSchema,
  projectSlugSchema,
  textSchema,
  titleSchema,
} from './fields.js';

const agentTarget = inProject({ agentId: idSchema });

const proposalMove = inProject({
  ticketId: idSchema,
  from: projectSlugSchema,
  to: projectSlugSchema,
  title: titleSchema.optional(),
  body: optionalTextSchema.optional(),
}).refine(
  (input) => input.from !== input.to,
  'planner.move needs two different projects',
);

const voyageTarget = z.strictObject({ voyage: z.int().positive() });

export const CREW_INTENTS = {
  'voyage.start': z.strictObject({ goal: textSchema }),
  'voyage.end': voyageTarget,
  'voyage.kill': voyageTarget,
  'project.kill': inProject({}),
  'pause.set': inProject({ paused: z.boolean() }),
  'pause.all': z.strictObject({ paused: z.boolean() }),
  'agent.pause': agentTarget,
  'agent.resume': agentTarget,
  'agent.end': agentTarget,
  'agent.kill': agentTarget,
  'agent.retire': agentTarget,
  'agent.reset': agentTarget,
  'agent.message': inProject({ agentId: idSchema, text: textSchema }),
  'planner.message': inProject({
    text: messageTextSchema,
    attachments: attachmentUploadsSchema,
  }).refine(
    (input) => hasTextOrAttachments(input.text, input.attachments),
    EMPTY_MESSAGE_REFUSAL,
  ),
  'planner.new': z.strictObject({}),
  'planner.move': proposalMove,
};

export type CrewIntentName = keyof typeof CREW_INTENTS;
