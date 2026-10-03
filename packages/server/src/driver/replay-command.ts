import { assertProjectSlug } from '../lib/slug.js';

export const REPLAY_COMMAND = 'npx quarterdeck replay';

export interface ReplayCommandParts {
  voyage: number;
  through?: number;
  project?: string;
}

const isPositive = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

export const assertThrough = (through: number): number => {
  if (!isPositive(through)) {
    throw new RangeError(
      `A replay runs turns up to n with n a positive integer, not ${through}`,
    );
  }
  return through;
};

const assertVoyage = (voyage: number): number => {
  if (!isPositive(voyage)) {
    throw new RangeError(`A voyage is a positive integer, not ${voyage}`);
  }
  return voyage;
};

export const replayCommand = (parts: ReplayCommandParts): string => {
  const words = [REPLAY_COMMAND, String(assertVoyage(parts.voyage))];
  if (parts.through !== undefined) {
    words.push(String(assertThrough(parts.through)));
  }
  if (parts.project !== undefined) {
    words.push('--project', assertProjectSlug(parts.project));
  }
  return words.join(' ');
};
