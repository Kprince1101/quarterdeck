import type { Queryable } from '../store/index.js';
import type {
  IntentName,
  IntentPayload,
  IntentReply,
  IntentResult,
} from '../intents/index.js';
import type { OpenRequests } from './open-requests.js';
import type { ProjectStores } from './project-stores.js';

export interface ApiContext {
  stores: ProjectStores;
  homeDir: string;
  openRequests?: OpenRequests | undefined;
}

export type IntentHandler<N extends IntentName> = (
  ctx: ApiContext,
  input: IntentPayload<N>,
  name: N,
) => Promise<IntentReply>;

export type IntentHandlers<N extends IntentName> = {
  [K in N]: IntentHandler<K>;
};

export type ProjectWork = (
  tx: Queryable,
  projectId: string,
) => Promise<IntentResult | null>;

export interface StagedWork {
  result: IntentResult | null;
  afterCommit: () => Promise<void>;
}

export type StagedProjectWork = (
  tx: Queryable,
  projectId: string,
) => Promise<StagedWork>;

export type ProjectCheck = (tx: Queryable, projectId: string) => Promise<void>;
