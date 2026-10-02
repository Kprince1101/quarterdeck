import { methods } from '@agentclientprotocol/sdk';
import type {
  ClientContext,
  InitializeResponse,
  LoadSessionResponse,
  NewSessionRequest,
  ResumeSessionResponse,
} from '@agentclientprotocol/sdk';
import { AcpClientError } from './errors.js';
import type {
  ResumeMethod,
  ResumeSetup,
  ResumedSession,
  SessionSetup,
} from './types.js';

export const sessionParams = ({
  cwd,
  mcpServers,
  meta,
}: SessionSetup): NewSessionRequest => {
  if (meta === undefined) return { cwd, mcpServers };
  return { cwd, mcpServers, _meta: meta };
};

type Resumer = (
  agent: ClientContext,
  setup: ResumeSetup,
) => Promise<ResumeSessionResponse | LoadSessionResponse>;

const RESUMERS: Record<ResumeMethod, Resumer> = {
  'session/resume': (agent, setup) =>
    agent.request(methods.agent.session.resume, {
      sessionId: setup.sessionId,
      ...sessionParams(setup),
    }),
  'session/load': (agent, setup) =>
    agent.request(methods.agent.session.load, {
      sessionId: setup.sessionId,
      ...sessionParams(setup),
    }),
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
