import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createFakeAgent } from './agent.ts';
import { parseFakeAgentArgs } from './args.ts';
import {
  FAKE_READY_LINE,
  FAKE_SIGN_IN_PROMPT,
  FAKE_TERMINAL_LOGIN_ARG,
  FAKE_TERMINAL_LOGIN_FAILS_ARG,
} from './constants.ts';

const argv = process.argv.slice(2);

if (argv.includes(FAKE_TERMINAL_LOGIN_ARG)) {
  process.stdout.write(`${FAKE_SIGN_IN_PROMPT}\n`);
  if (argv.includes(FAKE_TERMINAL_LOGIN_FAILS_ARG)) process.exit(2);
  process.exit(0);
}

const options = parseFakeAgentArgs(argv);

if (options.announce) process.stderr.write(`${FAKE_READY_LINE}\n`);
if (options.ignoreSigterm) process.on('SIGTERM', () => {});
if (options.silent || options.linger || options.ignoreSigterm) {
  setInterval(() => {}, 1_000);
}

if (!options.silent) {
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  );
  await createFakeAgent(options, {
    exitProcess: (code) => process.exit(code),
  }).connect(stream).closed;
}
