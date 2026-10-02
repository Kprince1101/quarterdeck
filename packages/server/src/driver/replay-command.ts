import { assertProjectSlug } from '../lib/slug.js';

export const REPLAY_COMMAND = 'npx quarterdeck replay';

export interface ReplayCommandParts {
  round: number;
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

const assertRound = (round: number): number => {
  if (!isPositive(round)) {
    throw new RangeError(`A round is a positive integer, not ${round}`);
  }
  return round;
};

export const replayCommand = (parts: ReplayCommandParts): string => {
  const words = [REPLAY_COMMAND, String(assertRound(parts.round))];
  if (parts.through !== undefined) {
    words.push(String(assertThrough(parts.through)));
  }
  if (parts.project !== undefined) {
    words.push('--project', assertProjectSlug(parts.project));
  }
  return words.join(' ');
};
