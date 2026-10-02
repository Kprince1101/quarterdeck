import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BusTool, BusToolSpec } from './tool.js';

export const BUS_TOOLS_DIR = fileURLToPath(new URL('tools/', import.meta.url));

const TOOL_FILE = /^[a-z][a-z0-9_]*\.(?:ts|js)$/;

const isToolSpec = (value: unknown): value is BusToolSpec => {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Partial<BusToolSpec>;
  return (
    typeof spec.description === 'string' &&
    typeof spec.input === 'object' &&
    spec.input !== null &&
    typeof spec.run === 'function'
  );
};

const loadTool = async (dir: string, file: string): Promise<BusTool> => {
  const module = (await import(pathToFileURL(join(dir, file)).href)) as {
    default?: unknown;
  };
  if (!isToolSpec(module.default))
    throw new Error(
      `bus tool ${file} must export default defineBusTool({ description, input, run })`,
    );
  return { ...module.default, name: basename(file, extname(file)) };
};

export const loadBusTools = async (
  dir: string = BUS_TOOLS_DIR,
): Promise<BusTool[]> => {
  const files = (await readdir(dir)).filter((file) => TOOL_FILE.test(file));
  const names = files.map((file) => basename(file, extname(file)));
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined)
    throw new Error(`bus tool ${repeated} is defined twice in ${dir}`);
  const tools = await Promise.all(files.map((file) => loadTool(dir, file)));
  return tools.toSorted((a, b) => a.name.localeCompare(b.name));
};
