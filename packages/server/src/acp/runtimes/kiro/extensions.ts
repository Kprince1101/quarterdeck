import type {
  AcpClient,
  AcpClientEvent,
  ExtensionParams,
} from '../../client/types.js';

export const KIRO_EXTENSIONS = {
  commandsAvailable: '_kiro.dev/commands/available',
  mcpOauthRequest: '_kiro.dev/mcp/oauth_request',
  mcpServerInitialized: '_kiro.dev/mcp/server_initialized',
  compactionStatus: '_kiro.dev/compaction/status',
  clearStatus: '_kiro.dev/clear/status',
  metadata: '_kiro.dev/metadata',
  agentSwitched: '_kiro.dev/agent/switched',
  sessionTerminate: '_session/terminate',
} as const;

export type KiroExtensionKind = keyof typeof KIRO_EXTENSIONS;
export type KiroExtensionMethod = (typeof KIRO_EXTENSIONS)[KiroExtensionKind];

export const KIRO_EXTENSION_NOTIFICATIONS: readonly KiroExtensionMethod[] =
  Object.values(KIRO_EXTENSIONS);

export interface KiroEvent {
  kind: KiroExtensionKind;
  method: KiroExtensionMethod;
  sessionId?: string;
  serverName?: string;
  url?: string;
  status?: string;
  contextUsagePercentage?: number;
  params: ExtensionParams;
}

const KINDS_BY_METHOD = new Map<string, KiroExtensionKind>(
  (Object.entries(KIRO_EXTENSIONS) as [KiroExtensionKind, string][]).map(
    ([kind, method]) => [method, kind],
  ),
);

const firstString = (
  params: ExtensionParams,
  keys: readonly string[],
): string | undefined =>
  keys
    .map((key) => params[key])
    .find((value): value is string => typeof value === 'string');

const statusOf = (params: ExtensionParams): string | undefined => {
  const { status } = params;
  if (typeof status === 'string') return status;
  if (typeof status === 'object' && status !== null && 'type' in status) {
    const { type } = status;
    if (typeof type === 'string') return type;
  }
  return undefined;
};

const percentageOf = (params: ExtensionParams): number | undefined => {
  const value = params['contextUsagePercentage'];
  if (typeof value === 'number') return value;
  return undefined;
};

type KiroEventFields = Omit<KiroEvent, 'kind' | 'method' | 'params'>;

const definedFields = (fields: {
  [Key in keyof KiroEventFields]-?: KiroEventFields[Key] | undefined;
}): KiroEventFields =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

export const toKiroEvent = (
  method: string,
  params: ExtensionParams,
): KiroEvent | undefined => {
  const kind = KINDS_BY_METHOD.get(method);
  if (kind === undefined) return undefined;
  return {
    kind,
    method: KIRO_EXTENSIONS[kind],
    ...definedFields({
      sessionId: firstString(params, ['sessionId']),
      serverName: firstString(params, ['serverName', 'server_name']),
      url: firstString(params, ['url', 'oauthUrl']),
      status: statusOf(params),
      contextUsagePercentage: percentageOf(params),
    }),
    params,
  };
};

export type KiroEventListener = (event: KiroEvent) => void;

export const subscribeKiroEvents = (
  client: Pick<AcpClient, 'subscribe'>,
  listener: KiroEventListener,
): (() => void) =>
  client.subscribe((event: AcpClientEvent) => {
    if (event.type !== 'extension') return;
    const kiroEvent = toKiroEvent(event.method, event.params);
    if (kiroEvent) listener(kiroEvent);
  });
