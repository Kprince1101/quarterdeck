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
  /\bgit\s[^;&|]*\bconfig\b[^;&|]*\balias\./,
  /--force\b/,
  /\brm\b[^;&|]*\s(?:-[a-z]*r|--recursive\b)/i,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\breset\b[^;&|]*\s--hard\b/,
];

const PROTECTED_BRANCHES = new Set(['HEAD', 'main', 'master']);
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const SAFE_PUSH_OPTIONS = new Set([
  '--set-upstream',
  '--quiet',
  '--verbose',
  '--dry-run',
  '--porcelain',
]);
const SAFE_PUSH_FLAGS = /^-[uqvn]+$/;
const SHELL_QUOTING = /['"\\$`]/;
const SHELL_QUOTING_OR_GLOB = /['"\\$`*?[\]{}()\n\r]/;
const GIT_SUBCOMMAND = /^[a-z][a-z-]*$/;
const BRANCH_MOVERS = new Set(['switch', 'checkout', 'branch', 'update-ref']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c']);
const SAFE_GIT_OPTIONS = new Set(['--no-pager', '-P']);
const COMMAND_SEPARATOR = /&&|\|\||[;&|\n]|:\s/;
const TRAILING_PUNCTUATION = /[.,:]+$/;

const UNRESOLVED_PATHS: readonly RegExp[] = [
  /(?:^|[^\w.])\.\.(?:$|[^\w.])/,
  /(?:^|[\s'"=:(])~/,
  /\$[{(\w]/,
  /`/,
];

const ABSOLUTE_PATH = /(?<![\w:/.])\/[^\s,'"`)]*/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const API_TOKEN = /#token=[\w-]+/g;

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface GitCall {
  subcommand: string;
  args: string[];
  quoted: boolean;
  unknownOptions: boolean;
}

const rawWords = (segment: string): string[] =>
  segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(TRAILING_PUNCTUATION, ''))
    .filter((word) => word !== '');

const unquoted = (word: string): string => word.replaceAll(/['"\\]/g, '');

const isGit = (word: string): boolean =>
  unquoted(word).split('/').at(-1) === 'git';

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

const onlySafeGitOptions = (options: readonly string[]): boolean => {
  let index = 0;
  while (index < options.length) {
    const option = options[index] ?? '';
    if (option === '-C') index += 2;
    else if (SAFE_GIT_OPTIONS.has(option)) index += 1;
    else return false;
  }
  return true;
};

export const gitCalls = (segment: string): GitCall[] => {
  const words = rawWords(segment);
  return words.flatMap((word, git) => {
    if (!isGit(word)) return [];
    const at = gitSubcommandAt(words, git + 1);
    const subcommand = words[at] ?? '';
    const args = words.slice(at + 1);
    const quoted = [word, subcommand, ...args].some((part) =>
      SHELL_QUOTING.test(part),
    );
    const unknownOptions = !onlySafeGitOptions(words.slice(git + 1, at));
    return [{ subcommand, args, quoted, unknownOptions }];
  });
};

const branchOf = (ref: string): string => ref.replace(/^refs\/heads\//, '');

const isPlainBranch = (ref: string): boolean =>
  BRANCH_NAME.test(ref) && !PROTECTED_BRANCHES.has(branchOf(ref));

const isAllowedRefspec = (refspec: string): boolean =>
  refspec.split(':').length <= 2 && refspec.split(':').every(isPlainBranch);

const isSafePushOption = (option: string): boolean =>
  SAFE_PUSH_OPTIONS.has(option) || SAFE_PUSH_FLAGS.test(option);

export const isAllowedPush = (args: readonly string[]): boolean => {
  if (!args.filter((arg) => arg.startsWith('-')).every(isSafePushOption))
    return false;
  const [remote, ...refspecs] = args.filter((arg) => !arg.startsWith('-'));
  if (remote === undefined || !BRANCH_NAME.test(remote)) return false;
  if (refspecs.length === 0) return false;
  return refspecs.every(isAllowedRefspec);
};

const namesProtectedBranch = (args: readonly string[]): boolean =>
  args.some((arg) =>
    arg
      .replace(/^\+/, '')
      .split(':')
      .some((ref) => PROTECTED_BRANCHES.has(branchOf(ref)) && ref !== 'HEAD'),
  );

const isRefusedGitCall = ({
  subcommand,
  args,
  quoted,
  unknownOptions,
}: GitCall): boolean => {
  if (unknownOptions) return true;
  if (!GIT_SUBCOMMAND.test(subcommand) && subcommand !== '') return true;
  if (subcommand === 'push') return quoted || !isAllowedPush(args);
  if (BRANCH_MOVERS.has(subcommand))
    return quoted || namesProtectedBranch(args);
  return false;
};

const refusesGit = (question: string): boolean =>
  question.split(COMMAND_SEPARATOR).flatMap(gitCalls).some(isRefusedGitCall);

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
  if (SHELL_QUOTING_OR_GLOB.test(question)) return 'deny';
  if (cwd === undefined || !isInside(posix.normalize(cwd), allowedRoots))
    return 'deny';
  const spaced = question.replaceAll(/\s+/g, ' ');
  if (REFUSED_COMMANDS.some((pattern) => pattern.test(spaced))) return 'deny';
  if (refusesGit(question)) return 'deny';
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
