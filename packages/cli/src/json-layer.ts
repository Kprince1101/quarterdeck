import { readFile } from 'node:fs/promises';
import { CliError } from './io.js';

export const readJsonLayer = async (
  path: string,
): Promise<Record<string, unknown>> => {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    throw new CliError(`${path} is not valid JSON`);
  }
  throw new CliError(`${path} is not a JSON object`);
};

export const jsonText = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
