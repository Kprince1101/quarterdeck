import { createInterface } from 'node:readline/promises';
import type { Prompter } from './io.js';

const YES = new Set(['y', 'yes']);
const NO = new Set(['', 'n', 'no']);

export const terminalPrompter = (): Prompter => ({
  ask: async (question) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const cancel = new AbortController();
    rl.on('SIGINT', () => cancel.abort());
    try {
      return await rl.question(question, { signal: cancel.signal });
    } finally {
      rl.close();
    }
  },
});

export const choose = async <T extends string>(
  prompter: Prompter,
  question: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> => {
  for (;;) {
    const answer = (await prompter.ask(question)).trim().toLowerCase();
    if (answer === '') return fallback;
    const choice = choices.find((option) => option === answer);
    if (choice !== undefined) return choice;
  }
};

export const confirm = async (
  prompter: Prompter,
  question: string,
): Promise<boolean> => {
  for (;;) {
    const answer = (await prompter.ask(question)).trim().toLowerCase();
    if (YES.has(answer)) return true;
    if (NO.has(answer)) return false;
  }
};
