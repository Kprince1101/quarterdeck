import type { FakeAgentFlag, FakeAgentOptions } from './types.ts';

export const REQUIRE_AUTH_FLAG = '--require-auth';
export const STEP_DELAY_PREFIX = '--step-delay-ms=';

export const FAKE_AGENT_FLAGS: Record<FakeAgentFlag, string> = {
  supportsLoad: '--supports-load',
  supportsResume: '--supports-resume',
  announce: '--announce',
  silent: '--silent',
  linger: '--linger',
  ignoreSigterm: '--ignore-sigterm',
};

const FLAG_ENTRIES = Object.entries(FAKE_AGENT_FLAGS) as [
  FakeAgentFlag,
  string,
][];

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
  FLAG_ENTRIES.forEach(([key, flag]) => {
    if (argv.includes(flag)) options[key] = true;
  });
  const delayArg = argv.find((arg) => arg.startsWith(STEP_DELAY_PREFIX));
  if (delayArg) options.stepDelayMs = parseStepDelay(delayArg);
  return options;
};

export const toFakeAgentArgs = (options: FakeAgentOptions): string[] => {
  const args: string[] = [];
  FLAG_ENTRIES.forEach(([key, flag]) => {
    if (options[key]) args.push(flag);
  });
  if (options.stepDelayMs !== undefined) {
    args.push(`${STEP_DELAY_PREFIX}${options.stepDelayMs}`);
  }
  if (options.requireAuth) args.push(REQUIRE_AUTH_FLAG);
  return args;
};
