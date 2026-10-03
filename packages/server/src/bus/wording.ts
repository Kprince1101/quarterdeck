import { forgeWording, type ForgeTerms } from '@quarterdeck/rules';
import { z } from 'zod';
import { BusToolError, type BusTool } from './tool.js';

const wordSchema = (
  schema: z.core.$ZodType,
  terms: ForgeTerms,
): z.core.$ZodType => {
  if (!(schema instanceof z.ZodType) || schema.description === undefined)
    return schema;
  return schema.describe(forgeWording(schema.description, terms));
};

const wordedError = (err: unknown, terms: ForgeTerms): unknown => {
  if (!(err instanceof BusToolError)) return err;
  return new BusToolError(forgeWording(err.message, terms), { cause: err });
};

const wordedRun =
  (tool: BusTool, terms: ForgeTerms): BusTool['run'] =>
  async (call, args) => {
    try {
      return forgeWording(await tool.run(call, args), terms);
    } catch (err) {
      throw wordedError(err, terms);
    }
  };

export const wordedTools = (
  tools: readonly BusTool[],
  terms: ForgeTerms,
): BusTool[] =>
  tools.map((tool) => ({
    ...tool,
    description: forgeWording(tool.description, terms),
    input: Object.fromEntries(
      Object.entries(tool.input).map(([key, schema]) => [
        key,
        wordSchema(schema, terms),
      ]),
    ),
    run: wordedRun(tool, terms),
  }));
