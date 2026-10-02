export const TOKENS = [
  'bg',
  'surface',
  'surface-raised',
  'line',
  'fg',
  'muted',
  'faint',
  'accent',
  'ok',
  'warn',
  'danger',
  'font',
  'mono',
  'text-sm',
  'text-md',
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'radius',
  'header-height',
] as const;

export type Token = (typeof TOKENS)[number];

export const tokenVar = (token: Token): string => `--qd-${token}`;

export const token = (name: Token): string => `var(${tokenVar(name)})`;
