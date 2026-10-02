import { posix } from 'node:path';

export type PermissionAnswer = 'allow' | 'deny';

export interface ScrubNames {
  home: string;
  repo: string;
  user: string;
  owner: string;
}

const REFUSED_COMMANDS: readonly RegExp[] = [
  /\bgh pr merge\b/,
  /--force\b/,
  /\bpush\s+-f\b/,
  /\brm\s+-[a-z]*r/,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\breset\s+--hard\b/,
];

const UNRESOLVED_PATHS: readonly RegExp[] = [
  /(?:^|[^\w.])\.\.(?:$|[^\w.])/,
  /(?:^|[\s'"=:(])~/,
  /\$[{(\w]/,
  /`/,
];

const ABSOLUTE_PATH = /(?<![\w:/.])\/[^\s,'"`)]+/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const API_TOKEN = /#token=[\w-]+/g;

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const permissionAnswer = (
  question: string,
  allowedRoots: readonly string[],
): PermissionAnswer => {
  if (REFUSED_COMMANDS.some((pattern) => pattern.test(question))) return 'deny';
  if (UNRESOLVED_PATHS.some((pattern) => pattern.test(question))) return 'deny';
  const paths = (question.match(ABSOLUTE_PATH) ?? []).map((path) =>
    posix.normalize(path),
  );
  const inside = paths.every((path) =>
    allowedRoots.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  if (inside) return 'allow';
  return 'deny';
};

export const createScrubber = (
  names: ScrubNames,
): ((text: string) => string) => {
  const replacements: [RegExp, string][] = [
    [new RegExp(escapeRegExp(names.home), 'g'), '$QD_HOME'],
    [new RegExp(escapeRegExp(names.repo), 'g'), '$REPO'],
    [new RegExp(`/(?:Users|home)/${escapeRegExp(names.user)}\\b`, 'g'), '~'],
    [new RegExp(`\\b${escapeRegExp(names.owner)}\\b`, 'gi'), '<owner>'],
    [EMAIL, '<email>'],
    [API_TOKEN, '#token=[redacted]'],
  ];
  return (text) =>
    replacements.reduce(
      (scrubbed, [pattern, placeholder]) =>
        scrubbed.replace(pattern, placeholder),
      text,
    );
};
