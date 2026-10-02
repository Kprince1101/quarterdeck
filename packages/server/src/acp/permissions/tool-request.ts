import { resolve } from 'node:path';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import { toolKindSchema, type ToolKind } from '@quarterdeck/rules';

export interface ToolRequest {
  kind: ToolKind;
  cwd: string;
  paths: string[];
  command?: string;
  url?: string;
}

type RawInput = Record<string, unknown>;

const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'notebook_path',
  'source',
  'destination',
  'old_path',
  'new_path',
] as const;
const COMMAND_KEYS = ['command', 'cmd'] as const;
const CWD_KEYS = ['cwd', 'working_dir', 'workdir', 'directory'] as const;
const URL_KEYS = ['url', 'uri'] as const;

const isRawInput = (value: unknown): value is RawInput =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rawInputOf = (toolCall: ToolCallUpdate): RawInput => {
  if (isRawInput(toolCall.rawInput)) return toolCall.rawInput;
  return {};
};

const nonBlank = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
};

const firstString = (
  input: RawInput,
  keys: readonly string[],
): string | undefined =>
  keys.map((key) => nonBlank(input[key])).find((value) => value !== undefined);

const commandOf = (input: RawInput): string | undefined => {
  const listed = COMMAND_KEYS.map((key) => input[key]).find(Array.isArray);
  if (listed?.every((part) => typeof part === 'string')) {
    return nonBlank(listed.join(' '));
  }
  return firstString(input, COMMAND_KEYS);
};

const diffPaths = (toolCall: ToolCallUpdate): string[] =>
  (toolCall.content ?? []).flatMap((content) => {
    if (content.type !== 'diff') return [];
    return [content.path];
  });

const declaredPaths = (toolCall: ToolCallUpdate, input: RawInput): string[] => [
  ...(toolCall.locations ?? []).map((location) => location.path),
  ...diffPaths(toolCall),
  ...PATH_KEYS.map((key) => nonBlank(input[key])).filter(
    (path) => path !== undefined,
  ),
];

const kindOf = (toolCall: ToolCallUpdate): ToolKind => {
  const parsed = toolKindSchema.safeParse(toolCall.kind);
  if (parsed.success) return parsed.data;
  return 'other';
};

export const describeToolCall = (
  toolCall: ToolCallUpdate,
  repoDir: string,
): ToolRequest => {
  const input = rawInputOf(toolCall);
  const cwd = resolve(repoDir, firstString(input, CWD_KEYS) ?? '.');
  const paths = [
    ...new Set(
      declaredPaths(toolCall, input).map((path) => resolve(cwd, path)),
    ),
  ];
  const request: ToolRequest = { kind: kindOf(toolCall), cwd, paths };
  const command = commandOf(input);
  const url = firstString(input, URL_KEYS);
  if (command !== undefined) request.command = command;
  if (url !== undefined) request.url = url;
  return request;
};
