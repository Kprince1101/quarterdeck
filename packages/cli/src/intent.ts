import {
  INTENTS,
  type IntentName,
  type IntentPayload,
} from '@quarterdeck/server/intents';
import { CliError } from './io.js';

export const parseIntent = <N extends IntentName>(
  name: N,
  value: unknown,
): IntentPayload<N> => {
  const parsed = INTENTS[name].safeParse(value);
  if (parsed.success) return parsed.data as IntentPayload<N>;
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  throw new CliError(`Invalid ${name}: ${issues.join('; ')}`);
};
