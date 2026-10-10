#!/usr/bin/env node
import { homedir } from 'node:os';
import { main } from './main.js';
import { terminalPrompter } from './prompt.js';
import { terminalSignIn } from './signin.js';

const untilStopped = () =>
  new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });

const prompter = () => {
  if (!process.stdin.isTTY) return undefined;
  return terminalPrompter();
};

const signIn = () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return {};
  return { signIn: terminalSignIn };
};

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  homeDir: homedir(),
  cwd: process.cwd(),
  env: process.env,
  prompter: prompter(),
  untilStopped,
  ...signIn(),
});
