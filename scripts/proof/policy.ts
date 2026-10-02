import { posix } from 'node:path';

export type PermissionAnswer = 'allow' | 'deny';

export interface ScrubNames {
  home: string;
  repo: string;
  user: string;
  owner: string;
}

const REFUSED_COMMANDS: readonly RegExp[] = [
  /\bgh\s[^;&|]*\bpr\s+merge\b/,
  /\bgh\s[^;&|]*\bapi\b[^;&|]*\/merge\b/,
  /--force\b/,
  /\brm\b[^;&|]*\s(?:-[a-z]*r|--recursive\b)/i,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\breset\s+--hard\b/,
];

const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD']);
const REFUSED_PUSH_OPTIONS =
  /^--(?:force|mirror|all|delete|tags|follow-tags|receive-pack|exec|prune)/;
const REFUSED_PUSH_FLAGS = /^-[a-zA-Z]*[fd]/;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c']);
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]|:\s/;
const QUOTES = /^['"]+|['"]+$/g;
const TRAILING_PUNCTUATION = /[.,:]+$/;

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

const shellWords = (segment: string): string[] =>
  segment
    .trim()
    .split(/\s+/)
    .map((word) =>
      word.replaceAll(QUOTES, '').replace(TRAILING_PUNCTUATION, ''),
    )
    .filter((word) => word !== '');

const gitSubcommandAt = (words: readonly string[], start: number): number => {
  let index = start;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (GIT_OPTIONS_WITH_VALUE.has(word)) index += 2;
    else if (word.startsWith('-')) index += 1;
    else return index;
  }
  return index;
};

export const pushArguments = (segment: string): string[] | undefined => {
  const words = shellWords(segment);
  const git = words.indexOf('git');
  if (git === -1) return undefined;
  const subcommand = gitSubcommandAt(words, git + 1);
  if (words[subcommand] !== 'push') return undefined;
  return words.slice(subcommand + 1);
};

const destinationOf = (refspec: string): string =>
  (refspec.split(':').at(-1) ?? '').replace(/^refs\/heads\//, '');

const isRefusedRefspec = (refspec: string): boolean =>
  refspec.startsWith('+') ||
  refspec.startsWith(':') ||
  DEFAULT_BRANCHES.has(destinationOf(refspec));

export const isRefusedPush = (args: readonly string[]): boolean => {
  const options = args.filter((arg) => arg.startsWith('-'));
  if (
    options.some(
      (option) =>
        REFUSED_PUSH_OPTIONS.test(option) || REFUSED_PUSH_FLAGS.test(option),
    )
  )
    return true;
  const [, ...refspecs] = args.filter((arg) => !arg.startsWith('-'));
  if (refspecs.length === 0) return true;
  return refspecs.some(isRefusedRefspec);
};

const refusesPush = (question: string): boolean =>
  question
    .split(COMMAND_SEPARATOR)
    .map(pushArguments)
    .some((args) => args !== undefined && isRefusedPush(args));

const RECOMMENDED_CWD = /should do this in (\/.*)\.$/;

export const cardCwd = (recommendation: unknown): string | undefined => {
  if (typeof recommendation !== 'string') return undefined;
  return RECOMMENDED_CWD.exec(recommendation)?.[1];
};

const isInside = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

export const permissionAnswer = (
  question: string,
  cwd: string | undefined,
  allowedRoots: readonly string[],
): PermissionAnswer => {
  if (cwd === undefined || !isInside(posix.normalize(cwd), allowedRoots))
    return 'deny';
  const spaced = question.replaceAll(/\s+/g, ' ');
  if (REFUSED_COMMANDS.some((pattern) => pattern.test(spaced))) return 'deny';
  if (refusesPush(question)) return 'deny';
  if (UNRESOLVED_PATHS.some((pattern) => pattern.test(question))) return 'deny';
  const paths = (question.match(ABSOLUTE_PATH) ?? []).map((path) =>
    posix.normalize(path),
  );
  if (paths.every((path) => isInside(path, allowedRoots))) return 'allow';
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
