import { LONG_OUTPUT_CHUNKS, LONG_OUTPUT_LINE_WIDTH } from './constants.ts';

export const longOutputLine = (index: number): string =>
  `${String(index).padStart(4, '0')} ${'x'.repeat(LONG_OUTPUT_LINE_WIDTH)}\n`;

export const longOutputLines = (): string[] =>
  Array.from({ length: LONG_OUTPUT_CHUNKS }, (_, index) =>
    longOutputLine(index),
  );

export const expectedLongOutput = (): string => longOutputLines().join('');
