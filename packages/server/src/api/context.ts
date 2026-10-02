import type { Transaction } from '@electric-sql/pglite';
import type {
  IntentName,
  IntentPayload,
  IntentReply,
  IntentResult,
} from '../intents/index.js';
import type { ProjectStores } from './project-stores.js';

export interface ApiContext {
  stores: ProjectStores;
  homeDir: string;
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
  tx: Transaction,
  projectId: string,
) => Promise<IntentResult | null>;

export interface StagedWork {
  result: IntentResult | null;
  afterCommit: () => Promise<void>;
}

export type StagedProjectWork = (
  tx: Transaction,
  projectId: string,
) => Promise<StagedWork>;

export type ProjectCheck = (
  tx: Transaction,
  projectId: string,
) => Promise<void>;
