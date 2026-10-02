import type { FakeAgentOptions } from './types.ts';

export const REQUIRE_AUTH_FLAG = '--require-auth';
export const STEP_DELAY_PREFIX = '--step-delay-ms=';

const parseStepDelay = (arg: string): number => {
  const value = Number(arg.slice(STEP_DELAY_PREFIX.length));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${arg}: expected a non-negative integer`);
  }
  return value;
};

export const parseFakeAgentArgs = (
  argv: readonly string[],
): FakeAgentOptions => {
  const options: FakeAgentOptions = {
    requireAuth: argv.includes(REQUIRE_AUTH_FLAG),
  };
  const delayArg = argv.find((arg) => arg.startsWith(STEP_DELAY_PREFIX));
  if (delayArg) options.stepDelayMs = parseStepDelay(delayArg);
  return options;
};

export const toFakeAgentArgs = (options: FakeAgentOptions): string[] => {
  const args: string[] = [];
  if (options.requireAuth) args.push(REQUIRE_AUTH_FLAG);
  if (options.stepDelayMs !== undefined) {
    args.push(`${STEP_DELAY_PREFIX}${options.stepDelayMs}`);
  }
  return args;
};
