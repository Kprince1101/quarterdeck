import { resolve } from 'node:path';

export const DEFAULT_RULES_DIR = resolve(import.meta.dirname, '..');
export const LOCAL_RULES_DIR = '.quarterdeck';
export const LOCAL_RULES_PREFIX = 'rules.local.';
