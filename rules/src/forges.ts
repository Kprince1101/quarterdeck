import { z } from 'zod';
import { RulesError } from './errors.js';

export const forgeSchema = z.enum(['github', 'gitlab']);

export type Forge = z.infer<typeof forgeSchema>;

export const FORGES = forgeSchema.options;

export interface ForgeTerms {
  short: 'PR' | 'MR';
  long: 'pull request' | 'merge request';
  cli: 'gh' | 'glab';
  name: 'GitHub' | 'GitLab';
}

export const FORGE_TERMS: Readonly<Record<Forge, ForgeTerms>> = {
  github: { short: 'PR', long: 'pull request', cli: 'gh', name: 'GitHub' },
  gitlab: { short: 'MR', long: 'merge request', cli: 'glab', name: 'GitLab' },
};

export const DEFAULT_FORGE: Forge = 'github';

export const KNOWN_FORGE_HOSTS: Readonly<Record<string, Forge>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
};

export const FORGES_FILE = 'forges.json';

export const MACHINE_FORGES_PATH = `~/.quarterdeck/rules.local.${FORGES_FILE}`;

export const REPO_FORGES_REFUSED = `the repo layer may not set forges; map hosts in ${MACHINE_FORGES_PATH}`;

export const refuseRepoForges = (
  _merged: unknown,
  _layer: unknown,
  path: string,
): never => {
  throw new RulesError(path, REPO_FORGES_REFUSED);
};

export const forgeTerms = (forge: Forge): ForgeTerms => FORGE_TERMS[forge];

export const upperFirst = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const inCaseOf = (match: string, word: string): string => {
  const first = match.charAt(0);
  if (first !== first.toUpperCase()) return word;
  return upperFirst(word);
};

const SHORT_ARTICLES: Record<ForgeTerms['short'], string> = {
  PR: 'a',
  MR: 'an',
};

export const forgeWording = (text: string, terms: ForgeTerms): string =>
  text
    .replace(/\bpull request/gi, (match) => inCaseOf(match, terms.long))
    .replace(
      /\b([Aa]n?) PR\b/g,
      (_match, article: string) =>
        `${inCaseOf(article, SHORT_ARTICLES[terms.short])} PR`,
    )
    .replace(
      /\bPR(s?)\b/g,
      (_match, plural: string) => `${terms.short}${plural}`,
    );

export class UnknownForgeError extends Error {
  readonly hostname: string;

  constructor(hostname: string) {
    super(
      `${hostname} is not a forge Quarterdeck knows; map it in ${MACHINE_FORGES_PATH}, for example { "forges": { "${hostname}": "gitlab" } }`,
    );
    this.name = 'UnknownForgeError';
    this.hostname = hostname;
  }
}

const lookup = (
  hosts: Readonly<Record<string, Forge>>,
  hostname: string,
): Forge | undefined => {
  if (!Object.hasOwn(hosts, hostname)) return undefined;
  return hosts[hostname];
};

const lowercaseKeys = (
  hosts: Readonly<Record<string, Forge>>,
): Record<string, Forge> =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, forge]) => [host.toLowerCase(), forge]),
  );

export const forgeOfHost = (
  hostname: string,
  mapped: Readonly<Record<string, Forge>>,
): Forge => {
  const host = hostname.toLowerCase();
  const forge =
    lookup(KNOWN_FORGE_HOSTS, host) ?? lookup(lowercaseKeys(mapped), host);
  if (forge === undefined) throw new UnknownForgeError(host);
  return forge;
};
