import { z } from 'zod';
import { idSchema, inProject, textSchema } from './fields.js';

const agentTarget = inProject({ agentId: idSchema });

export const CREW_INTENTS = {
  'voyage.start': inProject({ goal: textSchema }),
  'voyage.end': inProject({ voyageId: idSchema }),
  'voyage.kill': inProject({ voyageId: idSchema }),
  'pause.set': inProject({ paused: z.boolean() }),
  'pause.all': z.strictObject({ paused: z.boolean() }),
  'agent.pause': agentTarget,
  'agent.resume': agentTarget,
  'agent.end': agentTarget,
  'agent.kill': agentTarget,
  'agent.retire': agentTarget,
  'agent.reset': agentTarget,
  'agent.message': inProject({ agentId: idSchema, text: textSchema }),
  'planner.message': inProject({ text: textSchema }),
  'planner.new': inProject({}),
};

export type CrewIntentName = keyof typeof CREW_INTENTS;
