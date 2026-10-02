import {
  LARGE_OUTPUT_LINES,
  LONG_OUTPUT_CHUNKS,
  LONG_OUTPUT_LINE_WIDTH,
} from './constants.ts';

export const longOutputLine = (index: number): string =>
  `${String(index).padStart(4, '0')} ${'x'.repeat(LONG_OUTPUT_LINE_WIDTH)}\n`;

const outputLines = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => longOutputLine(index));

export const longOutputLines = (): string[] => outputLines(LONG_OUTPUT_CHUNKS);

export const expectedLongOutput = (): string => longOutputLines().join('');

export const expectedLargeOutput = (): string =>
  outputLines(LARGE_OUTPUT_LINES).join('');
