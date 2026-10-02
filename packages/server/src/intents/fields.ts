import { z } from 'zod';
import { RULE_SCHEMAS, type RuleName } from '@quarterdeck/rules/schemas';
import { PROJECT_SLUG } from '../lib/slug.js';

export const MAX_TEXT_LENGTH = 100_000;
export const MAX_TITLE_LENGTH = 200;

export const projectSlugSchema = z.string().regex(PROJECT_SLUG);

export const idSchema = z.uuid();

export const textSchema = z.string().trim().min(1).max(MAX_TEXT_LENGTH);

export const optionalTextSchema = z.string().max(MAX_TEXT_LENGTH);

export const titleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);

export const absolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => path.startsWith('/') || /^[a-z]:[\\/]/i.test(path),
    'must be an absolute path',
  );

export const ruleNameSchema = z.enum(
  Object.keys(RULE_SCHEMAS) as [RuleName, ...RuleName[]],
);

export const inProject = <Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<
  z.core.util.Writeable<{ project: typeof projectSlugSchema } & Shape>,
  z.core.$strict
> => z.strictObject({ project: projectSlugSchema, ...shape });

export const hasUniqueValues = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const changesSomething = (
  input: Record<string, unknown>,
  keys: readonly string[],
): boolean => keys.some((key) => input[key] !== undefined);
