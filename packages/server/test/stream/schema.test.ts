import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WATCHED_TABLES } from '../../src/store/index.js';
import {
  STREAM_TABLES,
  snapshotTablesSchema,
  streamMessageSchema,
} from '../../src/stream/schema.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';

describe('stream schema', () => {
  it('covers every watched table, in the snapshot and in changes', () => {
    expect(STREAM_TABLES).toEqual([...WATCHED_TABLES]);
    expect(Object.keys(snapshotTablesSchema.shape)).toEqual([
      ...WATCHED_TABLES,
    ]);
  });

  it('types change ids by table', () => {
    const turnDelete = {
      type: 'change',
      table: 'turns',
      op: 'delete',
      row: null,
    };
    expect(streamMessageSchema.parse({ ...turnDelete, id: 7 })).toEqual({
      ...turnDelete,
      id: 7,
    });
    expect(() =>
      streamMessageSchema.parse({ ...turnDelete, id: PROJECT }),
    ).toThrow();
    expect(() =>
      streamMessageSchema.parse({
        type: 'change',
        table: 'events',
        op: 'insert',
        id: 1,
        row: null,
      }),
    ).toThrow();
  });

  it('rejects messages the stream never sends', () => {
    expect(() =>
      streamMessageSchema.parse({ type: 'intent', ticket: PROJECT }),
    ).toThrow();
  });

  it('converts to JSON Schema for client generation', () => {
    const schema = z.toJSONSchema(streamMessageSchema);
    expect(JSON.stringify(schema)).toContain('"snapshot"');
  });
});
