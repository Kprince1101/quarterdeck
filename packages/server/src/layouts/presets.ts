import { z } from 'zod';
import {
  GRID_COLUMNS,
  GRID_ROWS,
  parseGridLayout,
  type GridItem,
  type GridLayout,
} from './spec.js';

const at = (
  widget: string,
  x: number,
  y: number,
  w: number,
  h: number,
): GridItem => ({ id: `${widget}-1`, widget, x, y, w, h, hidden: false });

const grid = (items: GridItem[]): GridLayout =>
  parseGridLayout({ columns: GRID_COLUMNS, rows: GRID_ROWS, items });

export const LAYOUT_PRESETS = {
  default: grid([
    at('board', 0, 0, 7, 8),
    { ...at('planner', 7, 0, 5, 8), tabs: ['driver', 'notebook'] },
    at('events', 0, 8, 6, 4),
    at('requests', 6, 8, 6, 4),
  ]),
  ops: grid([
    at('board', 0, 0, 6, 6),
    at('agents', 6, 0, 6, 6),
    at('cards', 0, 6, 3, 6),
    at('events', 3, 6, 3, 6),
    at('requests', 6, 6, 4, 6),
    at('usage', 10, 6, 2, 6),
  ]),
  minimal: grid([at('board', 0, 0, 8, 12), at('cards', 8, 0, 4, 12)]),
} satisfies Record<string, GridLayout>;

export type PresetName = keyof typeof LAYOUT_PRESETS;

export const PRESET_NAMES = Object.keys(LAYOUT_PRESETS) as [
  PresetName,
  ...PresetName[],
];

export const DEFAULT_PRESET: PresetName = 'default';

export const presetNameSchema = z.enum(PRESET_NAMES);

export const presetLayout = (name: PresetName): GridLayout =>
  structuredClone(LAYOUT_PRESETS[name]);
