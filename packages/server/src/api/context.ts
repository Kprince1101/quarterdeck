import type { GlobalLayouts } from '../global-layout/index.js';
import type { KeepAwake } from '../keep-awake/control.js';
import type { SetupProbe } from '../setup/probe.js';
import type { SetupSignIns } from '../setup/sign-ins.js';
import type { Queryable } from '../store/index.js';
import type { Workspaces } from '../workspace/index.js';
import type {
  IntentName,
  IntentPayload,
  IntentReply,
  IntentResult,
} from '../intents/index.js';
import type { OpenRequests } from './open-requests.js';
import type { ProjectStores } from './project-stores.js';

export type DeskReply =
  { ok: true; result: IntentResult } | { ok: false; error: string };

export interface ApiVoyages {
  start: (goal: string) => Promise<DeskReply>;
  end: (voyage: number) => Promise<DeskReply>;
  kill: (voyage: number) => Promise<DeskReply>;
}

export interface ApiContext {
  stores: ProjectStores;
  homeDir: string;
  layouts?: GlobalLayouts | undefined;
  workspaces?: Workspaces | undefined;
  openRequests?: OpenRequests | undefined;
  voyages?: ApiVoyages | undefined;
  setupProbe?: SetupProbe | undefined;
  setupSignIns?: SetupSignIns | undefined;
  keepAwake?: KeepAwake | undefined;
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
