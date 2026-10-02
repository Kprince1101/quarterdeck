import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createFakeAgent } from './agent.ts';
import { parseFakeAgentArgs } from './args.ts';
import { FAKE_READY_LINE } from './constants.ts';

const options = parseFakeAgentArgs(process.argv.slice(2));

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
