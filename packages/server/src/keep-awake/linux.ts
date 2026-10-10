import type { HoldSpec, KeepAwakeBackend } from './backend.js';

export const LINUX_INHIBIT_ARGS = ['--what=idle', '--why=Quarterdeck'];

export const untilOwnerExits = (ownerPid: number): string[] => [
  'tail',
  `--pid=${ownerPid}`,
  '-f',
  '/dev/null',
];

const timeLimit = (seconds: number | null): string[] => {
  if (seconds === null) return [];
  return ['timeout', String(seconds)];
};

export const LINUX_BACKEND: KeepAwakeBackend = {
  platform: 'linux',
  tool: 'systemd-inhibit',
  command: ({ seconds, ownerPid }: HoldSpec) => ({
    command: 'systemd-inhibit',
    args: [
      ...LINUX_INHIBIT_ARGS,
      ...timeLimit(seconds),
      ...untilOwnerExits(ownerPid),
    ],
  }),
};
