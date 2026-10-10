import type { HoldSpec, KeepAwakeBackend } from './backend.js';

const timeoutArgs = (seconds: number | null): string[] => {
  if (seconds === null) return [];
  return ['-t', String(seconds)];
};

export const MACOS_BACKEND: KeepAwakeBackend = {
  platform: 'darwin',
  tool: 'caffeinate',
  command: ({ seconds, ownerPid }: HoldSpec) => ({
    command: 'caffeinate',
    args: ['-i', ...timeoutArgs(seconds), '-w', String(ownerPid)],
  }),
};
