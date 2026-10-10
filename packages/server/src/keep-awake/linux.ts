import type { HoldSpec, KeepAwakeBackend } from './backend.js';

const sleepFor = (seconds: number | null): string => {
  if (seconds === null) return 'infinity';
  return String(seconds);
};

export const LINUX_BACKEND: KeepAwakeBackend = {
  platform: 'linux',
  tool: 'systemd-inhibit',
  command: ({ seconds }: HoldSpec) => ({
    command: 'systemd-inhibit',
    args: ['--what=idle', '--why=Quarterdeck', 'sleep', sleepFor(seconds)],
  }),
};
