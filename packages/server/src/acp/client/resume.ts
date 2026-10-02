import { methods } from '@agentclientprotocol/sdk';
import type {
  ClientContext,
  InitializeResponse,
  LoadSessionResponse,
  ResumeSessionResponse,
} from '@agentclientprotocol/sdk';
import { AcpClientError } from './errors.js';
import type { ResumeMethod, ResumeSetup, ResumedSession } from './types.js';

type Resumer = (
  agent: ClientContext,
  setup: ResumeSetup,
) => Promise<ResumeSessionResponse | LoadSessionResponse>;

const RESUMERS: Record<ResumeMethod, Resumer> = {
  'session/resume': (agent, setup) =>
    agent.request(methods.agent.session.resume, setup),
  'session/load': (agent, setup) =>
    agent.request(methods.agent.session.load, setup),
};

export const pickResumeMethod = (
  initialized: InitializeResponse,
): ResumeMethod | undefined => {
  const capabilities = initialized.agentCapabilities;
  if (capabilities?.sessionCapabilities?.resume) return 'session/resume';
  if (capabilities?.loadSession) return 'session/load';
  return undefined;
};

export const resumeSession = async (
  agent: ClientContext,
  initialized: InitializeResponse,
  setup: ResumeSetup,
): Promise<ResumedSession> => {
  const method = pickResumeMethod(initialized);
  if (!method) {
    throw new AcpClientError(
      'Agent supports neither session/resume nor session/load',
      'resume_unsupported',
    );
  }
  const response = await RESUMERS[method](agent, setup);
  return { sessionId: setup.sessionId, method, response };
};
