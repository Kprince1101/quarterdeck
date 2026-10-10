import { vi } from 'vitest';
import type {
  HeldProcess,
  HoldCommand,
  KeepAwakeSupport,
  SpawnHold,
} from '../../src/keep-awake/index.js';

export interface FakeHeld extends HeldProcess {
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stopNow: ReturnType<typeof vi.fn<() => void>>;
  exit: () => void;
}

export interface FakeSpawner {
  spawn: SpawnHold;
  commands: HoldCommand[];
  held: FakeHeld[];
}

export const FAKE_PID_BASE = 40_000;

export const fakeSpawner = (): FakeSpawner => {
  const commands: HoldCommand[] = [];
  const held: FakeHeld[] = [];
  const spawn: SpawnHold = (command) => {
    let exit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const process: FakeHeld = {
      pid: FAKE_PID_BASE + held.length,
      startedAt: new Date(),
      exited,
      exit,
      stop: vi.fn(async () => {
        exit();
        await exited;
      }),
      stopNow: vi.fn(),
    };
    commands.push(command);
    held.push(process);
    return Promise.resolve(process);
  };
  return { spawn, commands, held };
};

export const AVAILABLE = (tool: string) => (): Promise<KeepAwakeSupport> =>
  Promise.resolve({ available: true, tool, path: `/usr/bin/${tool}` });

export const MISSING = (tool: string) => (): Promise<KeepAwakeSupport> =>
  Promise.resolve({
    available: false,
    tool,
    reason: `${tool} is not on PATH, so Quarterdeck cannot keep this computer awake.`,
  });
