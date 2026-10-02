import type { z } from 'zod';
import type { Store } from '../store/index.js';

export type BusStore = Pick<Store, 'db' | 'projectId' | 'publish'>;

export interface BusContext {
  store: BusStore;
  agentId: string;
}

export interface BusToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  input: Shape;
  run(context: BusContext, args: z.output<z.ZodObject<Shape>>): Promise<string>;
}

export interface BusTool extends BusToolSpec {
  name: string;
}

export class BusToolError extends Error {
  override name = 'BusToolError';
}

export const defineBusTool = <Shape extends z.ZodRawShape>(
  spec: BusToolSpec<Shape>,
): BusToolSpec<Shape> => spec;
