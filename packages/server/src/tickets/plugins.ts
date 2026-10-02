import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getErrorMessage, hasErrorCode } from '../lib/errors.js';
import { PROJECT_SLUG } from '../lib/slug.js';
import { quarterdeckHome, type Store } from '../store/index.js';
import { TicketSourcePluginError } from './errors.js';
import { LOCAL_TICKET_SOURCE, localTicketSource } from './local.js';
import {
  pluginSource,
  type TicketSource,
  type TicketSourceMethods,
} from './source.js';

export const TICKET_PLUGIN_NAME = PROJECT_SLUG;

const METHODS: readonly (keyof TicketSourceMethods)[] = [
  'listApproved',
  'setStatus',
  'note',
  'attachPr',
];

export interface TicketSourceContext {
  name: string;
  project: string;
}

export type TicketSourcePlugin = (
  context: TicketSourceContext,
) => TicketSourceMethods | Promise<TicketSourceMethods>;

export interface LoadTicketSourceOptions {
  project: string;
  home?: string;
}

export interface OpenTicketSourceOptions {
  project: string;
  plugin?: string | undefined;
}

export const ticketPluginsDir = (home: string = quarterdeckHome()): string =>
  join(home, 'plugins');

export const ticketPluginPath = (
  name: string,
  home: string = quarterdeckHome(),
): string => {
  if (!TICKET_PLUGIN_NAME.test(name))
    throw new TicketSourcePluginError(
      JSON.stringify(name),
      `a plugin name is ${TICKET_PLUGIN_NAME.source}`,
    );
  if (name === LOCAL_TICKET_SOURCE)
    throw new TicketSourcePluginError(
      name,
      `${LOCAL_TICKET_SOURCE} is the tickets table, not a plugin`,
    );
  return join(ticketPluginsDir(home), `${name}.mjs`);
};

const realPluginsDir = async (name: string, dir: string): Promise<string> => {
  let real: string;
  try {
    real = await realpath(dir);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT'))
      throw new TicketSourcePluginError(name, `there is no folder ${dir}`);
    throw err;
  }
  if (real !== resolve(dir))
    throw new TicketSourcePluginError(
      name,
      `${dir} resolves to ${real}; the plugins folder cannot be reached through a symlink`,
    );
  return real;
};

const resolvePluginInside = async (
  name: string,
  path: string,
  dir: string,
): Promise<string> => {
  const realDir = await realPluginsDir(name, dir);
  let real: string;
  try {
    real = await realpath(path);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT'))
      throw new TicketSourcePluginError(name, `there is no file ${path}`);
    throw err;
  }
  if (dirname(real) !== realDir)
    throw new TicketSourcePluginError(
      name,
      `${path} resolves to ${real}, outside ${dir}`,
    );
  return real;
};

const importPlugin = async (
  name: string,
  path: string,
): Promise<TicketSourcePlugin> => {
  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (err) {
    throw new TicketSourcePluginError(
      name,
      `importing ${path} failed: ${getErrorMessage(err)}`,
      { cause: err },
    );
  }
  if (typeof loaded.default !== 'function')
    throw new TicketSourcePluginError(
      name,
      `${path} has no default export function`,
    );
  return loaded.default as TicketSourcePlugin;
};

const createMethods = async (
  name: string,
  plugin: TicketSourcePlugin,
  context: TicketSourceContext,
): Promise<TicketSourceMethods> => {
  let methods: unknown;
  try {
    methods = await plugin(context);
  } catch (err) {
    throw new TicketSourcePluginError(
      name,
      `its default export threw: ${getErrorMessage(err)}`,
      { cause: err },
    );
  }
  if (typeof methods !== 'object' || methods === null)
    throw new TicketSourcePluginError(
      name,
      'its default export did not return an object',
    );
  const record = methods as Record<string, unknown>;
  const missing = METHODS.filter((key) => typeof record[key] !== 'function');
  if (missing.length > 0)
    throw new TicketSourcePluginError(
      name,
      `it has no ${missing.join(', ')} function`,
    );
  return methods as TicketSourceMethods;
};

export const loadTicketSource = async (
  name: string,
  options: LoadTicketSourceOptions,
): Promise<TicketSource> => {
  const home = options.home ?? quarterdeckHome();
  const path = ticketPluginPath(name, home);
  const real = await resolvePluginInside(name, path, ticketPluginsDir(home));
  const plugin = await importPlugin(name, real);
  const methods = await createMethods(name, plugin, {
    name,
    project: options.project,
  });
  return pluginSource(name, methods);
};

export const openTicketSource = async (
  store: Store,
  options: OpenTicketSourceOptions,
): Promise<TicketSource> => {
  if (options.plugin === undefined) return localTicketSource(store);
  return loadTicketSource(options.plugin, { project: options.project });
};
