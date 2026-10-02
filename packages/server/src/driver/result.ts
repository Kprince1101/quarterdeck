import { z } from 'zod';
import { getErrorMessage } from '../lib/errors.js';
import { BUILDER_ACTION_INSTRUCTIONS } from './action-schemas.js';

export interface TurnFormat<T> {
  schema: z.ZodType<T>;
  instructions: string;
}

export type ParsedTurnResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

const FENCED_BLOCK = /```[a-zA-Z]*[^\S\n]*\n([\s\S]*?)```/g;

const fencedBlocks = (text: string): string[] =>
  [...text.matchAll(FENCED_BLOCK)].map((match) => match[1] ?? '');

const outerBraces = (text: string): string[] => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  return [text.slice(start, end + 1)];
};

export const jsonCandidates = (text: string): string[] =>
  [...fencedBlocks(text).reverse(), text, ...outerBraces(text)]
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('{'));

type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

const parseJson = (candidate: string): JsonParse => {
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
};

export const parseTurnResult = <T>(
  text: string,
  schema: z.ZodType<T>,
): ParsedTurnResult<T> => {
  const candidates = jsonCandidates(text);
  if (candidates.length === 0) {
    return { ok: false, error: 'the reply has no JSON object' };
  }
  let firstError = '';
  for (const candidate of candidates) {
    const parsed = parseJson(candidate);
    if (!parsed.ok) {
      firstError ||= `the reply's JSON does not parse: ${parsed.error}`;
      continue;
    }
    const result = schema.safeParse(parsed.value);
    if (result.success) return { ok: true, value: result.data };
    return {
      ok: false,
      error: `the turn result does not match its shape:\n${z.prettifyError(result.error)}`,
    };
  }
  return { ok: false, error: firstError };
};

export const repromptText = (error: string, instructions: string): string =>
  [
    `Your last reply had no valid turn result: ${error}`,
    'Reply again with the turn result only.',
    instructions,
  ].join('\n\n');

export const driverActionSchema = z.looseObject({
  kind: z.string().min(1),
});

export const driverTurnResultSchema = z.object({
  summary: z.string().min(1),
  actions: z.array(driverActionSchema),
});

export type DriverAction = z.infer<typeof driverActionSchema>;
export type DriverTurnResult = z.infer<typeof driverTurnResultSchema>;

export const DRIVER_TURN_INSTRUCTIONS = `End every reply with your turn result: one JSON object in a \`\`\`json fenced block, with nothing after it.

\`\`\`json
{ "summary": "Assigned QD12 to a new builder; QD9 waits on QD7.", "actions": [] }
\`\`\`

- \`summary\`: one or two sentences on what you did this turn and why.
- \`actions\`: what Quarterdeck should do next, in order, or \`[]\` when there is nothing to do. Each action is an object with a \`kind\` and that kind's fields.

${BUILDER_ACTION_INSTRUCTIONS}`;

export const DRIVER_TURN_FORMAT: TurnFormat<DriverTurnResult> = {
  schema: driverTurnResultSchema,
  instructions: DRIVER_TURN_INSTRUCTIONS,
};
