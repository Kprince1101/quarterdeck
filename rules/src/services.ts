import { RulesError } from './errors.js';

export const SERVICES_FILE = 'services.json';

export const MACHINE_SERVICES_PATH = `~/.quarterdeck/rules.local.${SERVICES_FILE}`;

export const REPO_SERVICES_REFUSED = `the repo layer may not set services; set a project's tracker and publishes in ${MACHINE_SERVICES_PATH} or the Project widget`;

export const refuseRepoServices = (
  _merged: unknown,
  _layer: unknown,
  path: string,
): never => {
  throw new RulesError(path, REPO_SERVICES_REFUSED);
};
