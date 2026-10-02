import { z } from 'zod';
import { defineBusTool } from '../tool.js';

export const STATUS_MAX = 200;

export default defineBusTool({
  description: `Set your one-line progress note on the board (at most ${STATUS_MAX} characters).`,
  input: {
    text: z
      .string()
      .transform((text) => text.replaceAll(/\s+/g, ' ').trim())
      .pipe(z.string().min(1).max(STATUS_MAX)),
  },
  run: async ({ store, agentId }, { text }) => {
    await store.publish({ kind: 'agent.status', agentId, payload: { text } });
    return 'noted';
  },
});
