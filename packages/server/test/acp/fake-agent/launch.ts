import { fileURLToPath } from 'node:url';
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';
import { createFakeAgent } from './agent.ts';
import { toFakeAgentArgs } from './args.ts';
import type { FakeAgentLaunch, FakeAgentOptions } from './types.ts';

export const FAKE_AGENT_ENTRY = fileURLToPath(
  new URL('main.ts', import.meta.url),
);

const NODE_FLAGS = [
  '--experimental-strip-types',
  '--disable-warning=ExperimentalWarning',
];

export const fakeAgentLaunch = (
  options: FakeAgentOptions = {},
): FakeAgentLaunch => ({
  command: process.execPath,
  args: [...NODE_FLAGS, FAKE_AGENT_ENTRY, ...toFakeAgentArgs(options)],
});

export const connectFakeAgentInProcess = (
  options: FakeAgentOptions = {},
): Stream => {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  createFakeAgent(options).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  });
  return { readable: toClient.readable, writable: toAgent.writable };
};
