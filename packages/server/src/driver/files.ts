import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

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
  await mkdir(dir, { recursive: true });
  await writeFile(turnFile(dir, 'input'), input);
};

export const writeTurnOutput = async (
  dir: string,
  text: string,
  updates: readonly SessionUpdate[],
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(turnFile(dir, 'output'), text);
  await writeFile(
    turnFile(dir, 'updates'),
    updates.map((update) => `${JSON.stringify(update)}\n`).join(''),
  );
};

export const writeTurnResult = (dir: string, result: unknown): Promise<void> =>
  writeFile(turnFile(dir, 'result'), `${JSON.stringify(result, null, 2)}\n`);
