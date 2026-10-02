import type { Permissions, PermissionRule } from './schemas.js';

const INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'node',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'npx',
  'pnpx',
  'bunx',
  'env',
  'xargs',
  'sudo',
  'nohup',
  'exec',
  'eval',
]);

const VERSION_SUFFIX = /[\d.]+$/;
const EXE_SUFFIX = /\.exe$/i;
const WILDCARD = /[*?]/;
const STARS_ONLY = /^\*+$/;

const commandName = (word: string): string =>
  (word.split(/[\\/]/).at(-1) ?? word)
    .replace(EXE_SUFFIX, '')
    .replace(VERSION_SUFFIX, '')
    .toLowerCase();

const literalPrefix = (pattern: string): string =>
  pattern.slice(0, pattern.search(WILDCARD));

const patternWarning = (pattern: string): string | undefined => {
  const quoted = `execute allow "${pattern}"`;
  const [first = '', ...rest] = pattern.trim().split(/\s+/);
  if (WILDCARD.test(first)) {
    const prefix = literalPrefix(first);
    if (prefix === '') return `${quoted} permits any command.`;
    return `${quoted} permits any command that starts with "${prefix}".`;
  }
  const name = commandName(first);
  if (INTERPRETERS.has(name)) {
    return `${quoted} permits ${name}, which can run any code.`;
  }
  if (rest.length > 0 && rest.every((word) => STARS_ONLY.test(word))) {
    return `${quoted} permits ${first} with any arguments, which can run any code.`;
  }
  return undefined;
};

const ruleWarning = (rule: PermissionRule): string | undefined => {
  if (rule.kind !== 'execute' || rule.decision !== 'allow') return undefined;
  if (rule.pattern === undefined) {
    return 'execute allow with no pattern permits any command.';
  }
  return patternWarning(rule.pattern);
};

const defaultWarning = (permissions: Permissions): string | undefined => {
  if (permissions.default !== 'allow') return undefined;
  const general = permissions.rules.some(
    (rule) => rule.kind === 'execute' && rule.pattern === undefined,
  );
  if (general) return undefined;
  return 'default "allow" permits any command no execute rule names.';
};

export const shellAllowWarnings = (permissions: Permissions): string[] => [
  ...new Set(
    [defaultWarning(permissions), ...permissions.rules.map(ruleWarning)].filter(
      (warning) => warning !== undefined,
    ),
  ),
];
