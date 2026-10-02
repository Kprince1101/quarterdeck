export const PRIVATE_NAMES_FILE = 'rules/test/private-names.ts';

export const PRIVATE_NAMES = [
  'commander',
  'kprince1101',
  'legion',
  'naic',
  'newt',
  'supabase',
  'thimble',
];

export const TOOLKIT = 'legion-toolkit';

const PRIVATE_NAME = new RegExp(`\\b(?:${PRIVATE_NAMES.join('|')})\\b`, 'gi');

export const privateNamesIn = (text: string): string[] =>
  text.match(PRIVATE_NAME) ?? [];
