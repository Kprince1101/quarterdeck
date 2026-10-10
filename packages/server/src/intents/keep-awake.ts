import { z } from 'zod';
import { keepAwakeStateSchema } from '../stream/schema.js';

export const KEEP_AWAKE_MINUTES = [30, 60, 120, 240, 480] as const;

export const MAX_KEEP_AWAKE_MINUTES = 24 * 60;

export const keepAwakeRequestSchema = z.union([
  z.strictObject({ minutes: z.int().min(1).max(MAX_KEEP_AWAKE_MINUTES) }),
  z.strictObject({ untilVoyageEnds: z.literal(true) }),
]);

export type KeepAwakeRequest = z.infer<typeof keepAwakeRequestSchema>;

export const KEEP_AWAKE_INTENTS = {
  'keepAwake.start': keepAwakeRequestSchema,
  'keepAwake.stop': z.strictObject({}),
};

export type KeepAwakeIntentName = keyof typeof KEEP_AWAKE_INTENTS;

export const keepAwakeResultSchema = z.object({
  keepAwake: keepAwakeStateSchema,
});

export type KeepAwakeResult = z.infer<typeof keepAwakeResultSchema>;
