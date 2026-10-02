import { join } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { ensurePrivateDir, writePrivateFile } from '../lib/private-fs.js';
import { redactSecrets, redactValue } from '../lib/redact.js';

export const TURN_FILES = {
  input: 'input.md',
  output: 'output.md',
  updates: 'updates.jsonl',
  result: 'result.json',
} as const;

export type TurnFile = keyof typeof TURN_FILES;

const SEQ_WIDTH = 4;

export const turnDir = (turnsDir: string, agentId: string, seq: number) =>
  join(turnsDir, agentId, String(seq).padStart(SEQ_WIDTH, '0'));

export const turnFile = (dir: string, file: TurnFile): string =>
  join(dir, TURN_FILES[file]);

export const writeTurnInput = async (
  dir: string,
  input: string,
): Promise<void> => {
  await ensurePrivateDir(dir);
  await writePrivateFile(turnFile(dir, 'input'), redactSecrets(input));
};

type TextChunk = Extract<
  SessionUpdate,
  { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' }
>;

const chunkText = (update: SessionUpdate): string | undefined => {
  if (
    update.sessionUpdate !== 'agent_message_chunk' &&
    update.sessionUpdate !== 'agent_thought_chunk'
  ) {
    return undefined;
  }
  if (update.content.type !== 'text') return undefined;
  return update.content.text;
};

const withText = (chunk: SessionUpdate, text: string): SessionUpdate => {
  const { content } = chunk as TextChunk;
  return { ...chunk, content: { ...content, text } } as SessionUpdate;
};

export const mergeTextChunks = (
  updates: readonly SessionUpdate[],
): SessionUpdate[] => {
  const merged: SessionUpdate[] = [];
  for (const update of updates) {
    const last = merged.at(-1);
    const text = chunkText(update);
    const lastText = last && chunkText(last);
    if (
      last === undefined ||
      lastText === undefined ||
      text === undefined ||
      last.sessionUpdate !== update.sessionUpdate
    ) {
      merged.push(update);
    } else {
      merged[merged.length - 1] = withText(last, lastText + text);
    }
  }
  return merged;
};

export const writeTurnOutput = async (
  dir: string,
  text: string,
  updates: readonly SessionUpdate[],
): Promise<void> => {
  await ensurePrivateDir(dir);
  await writePrivateFile(turnFile(dir, 'output'), redactSecrets(text));
  await writePrivateFile(
    turnFile(dir, 'updates'),
    redactValue(mergeTextChunks(updates))
      .map((update) => `${JSON.stringify(update)}\n`)
      .join(''),
  );
};

export const writeTurnResult = (dir: string, result: unknown): Promise<void> =>
  writePrivateFile(
    turnFile(dir, 'result'),
    `${JSON.stringify(redactValue(result), null, 2)}\n`,
  );
