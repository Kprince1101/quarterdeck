import type { HoldSpec, KeepAwakeBackend } from './backend.js';

export const ES_CONTINUOUS = 0x80000000;

export const ES_SYSTEM_REQUIRED = 0x00000001;

export const ES_DISPLAY_REQUIRED = 0x00000002;

export const WINDOWS_EXECUTION_STATE =
  (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0;

const waitLimit = (seconds: number | null): string => {
  if (seconds === null) return '';
  return ` -Timeout ${seconds}`;
};

export const windowsKeepAwakeScript = ({
  seconds,
  ownerPid,
}: HoldSpec): string =>
  [
    `$signature = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
    '$kernel = Add-Type -MemberDefinition $signature -Name ExecutionState -Namespace Quarterdeck -PassThru',
    `[void]$kernel::SetThreadExecutionState([uint32]${WINDOWS_EXECUTION_STATE})`,
    `Wait-Process -Id ${ownerPid}${waitLimit(seconds)} -ErrorAction SilentlyContinue`,
  ].join('\n');

export const encodePowerShell = (script: string): string =>
  Buffer.from(script, 'utf16le').toString('base64');

export const WINDOWS_BACKEND: KeepAwakeBackend = {
  platform: 'win32',
  tool: 'powershell',
  command: (hold: HoldSpec) => ({
    command: 'powershell',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell(windowsKeepAwakeScript(hold)),
    ],
  }),
};
