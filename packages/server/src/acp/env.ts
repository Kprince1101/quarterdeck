export const CHILD_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TZ',
  'SSH_AUTH_SOCK',
];

export const WINDOWS_CHILD_ENV_NAMES: readonly string[] = [
  'APPDATA',
  'ComSpec',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'windir',
];

export const CHILD_ENV_PREFIXES: readonly string[] = [
  'LC_',
  'QUARTERDECK_BUS_',
];

export interface ChildEnvSpec {
  pass?: readonly string[];
  set?: Readonly<Record<string, string>>;
  source?: NodeJS.ProcessEnv;
}

export type ChildEnv = Record<string, string>;

const IS_WINDOWS = process.platform === 'win32';

const envKey = (name: string): string => {
  if (IS_WINDOWS) return name.toUpperCase();
  return name;
};

const baseNames = (): readonly string[] => {
  if (IS_WINDOWS) return [...CHILD_ENV_NAMES, ...WINDOWS_CHILD_ENV_NAMES];
  return CHILD_ENV_NAMES;
};

export const childEnv = ({
  pass = [],
  set = {},
  source = process.env,
}: ChildEnvSpec = {}): ChildEnv => {
  const names = new Set([...baseNames(), ...pass].map(envKey));
  const allowed = (name: string) =>
    names.has(envKey(name)) ||
    CHILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
  const env: ChildEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed(name)) env[name] = value;
  }
  return { ...env, ...set };
};

export const withChildEnv = (
  spec: ChildEnvSpec | undefined,
  extra: ChildEnvSpec,
): ChildEnvSpec => {
  const merged: ChildEnvSpec = {
    pass: [...(spec?.pass ?? []), ...(extra.pass ?? [])],
    set: { ...spec?.set, ...extra.set },
  };
  const source = extra.source ?? spec?.source;
  if (source !== undefined) merged.source = source;
  return merged;
};
