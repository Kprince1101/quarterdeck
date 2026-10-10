import { forgeWording, type ForgeTerms } from '@quarterdeck/rules';
import { z } from 'zod';
import type { WorkspaceMode } from '../stream/schema.js';
import { DEFAULT_WORKSPACE_MODE } from '../workspace/feed.js';
import { workspaceWording } from '../workspace/wording.js';
import { BusToolError, type BusTool } from './tool.js';

type Worder = (text: string) => string;

const wordSchema = (schema: z.core.$ZodType, word: Worder): z.core.$ZodType => {
  if (!(schema instanceof z.ZodType) || schema.description === undefined)
    return schema;
  return schema.describe(word(schema.description));
};

const wordedError = (err: unknown, word: Worder): unknown => {
  if (!(err instanceof BusToolError)) return err;
  return new BusToolError(word(err.message), { cause: err });
};

const wordedRun =
  (tool: BusTool, word: Worder): BusTool['run'] =>
  async (call, args) => {
    try {
      return await tool.run(call, args);
    } catch (err) {
      throw wordedError(err, word);
    }
  };

export const wordedTools = (
  tools: readonly BusTool[],
  terms: ForgeTerms,
  mode: WorkspaceMode = DEFAULT_WORKSPACE_MODE,
): BusTool[] => {
  const word: Worder = (text) =>
    workspaceWording(forgeWording(text, terms), mode);
  return tools.map((tool) => ({
    ...tool,
    description: word(tool.description),
    input: Object.fromEntries(
      Object.entries(tool.input).map(([key, schema]) => [
        key,
        wordSchema(schema, word),
      ]),
    ),
    run: wordedRun(tool, word),
  }));
};
