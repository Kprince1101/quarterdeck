import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createFakeAgent } from './agent.ts';
import { parseFakeAgentArgs } from './args.ts';

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

await createFakeAgent(parseFakeAgentArgs(process.argv.slice(2))).connect(stream)
  .closed;
