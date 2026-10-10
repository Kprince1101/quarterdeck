import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTACHED_PATHS_INTRO,
  AttachmentError,
  planPrompt,
  removeAttachments,
  saveAttachments,
} from '../../src/attachments/index.js';
import {
  ATTACHMENT_COUNT_REFUSAL,
  ATTACHMENT_SIZE_REFUSAL,
  ATTACHMENT_TYPE_REFUSAL,
  EMPTY_MESSAGE_REFUSAL,
  INTENTS,
  attachmentUrl,
  base64Bytes,
} from '../../src/intents/index.js';
import {
  GIF_DATA,
  JPEG_DATA,
  PNG_BYTES,
  PNG_DATA,
  WEBP_DATA,
  oversized,
  png,
} from './fixtures.ts';

const IS_WINDOWS = process.platform === 'win32';

const issuesOf = (input: unknown): string[] => {
  const parsed = INTENTS['planner.message'].safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map(({ message }) => message);
};

describe('attachment intents', () => {
  it('takes text, images, or both, and refuses a message with neither', () => {
    expect(issuesOf({ project: 'deck', text: 'hi' })).toEqual([]);
    expect(issuesOf({ project: 'deck', attachments: [png()] })).toEqual([]);
    expect(issuesOf({ project: 'deck', text: '  ' })).toEqual([
      EMPTY_MESSAGE_REFUSAL,
    ]);
    expect(
      INTENTS['card.answer'].safeParse({
        project: 'deck',
        cardId: crypto.randomUUID(),
        attachments: [png()],
      }).success,
    ).toBe(true);
  });

  it('refuses another type, more than five images, or one over 5 MB', () => {
    expect(
      issuesOf({
        project: 'deck',
        attachments: [{ mimeType: 'image/svg+xml', data: PNG_DATA }],
      }),
    ).toEqual([ATTACHMENT_TYPE_REFUSAL]);
    expect(
      issuesOf({
        project: 'deck',
        attachments: Array.from({ length: 6 }, png),
      }),
    ).toEqual([ATTACHMENT_COUNT_REFUSAL]);
    expect(issuesOf({ project: 'deck', attachments: [oversized()] })).toEqual([
      ATTACHMENT_SIZE_REFUSAL,
    ]);
  });

  it('counts the bytes a base64 string decodes to', () => {
    expect(base64Bytes(PNG_DATA)).toBe(PNG_BYTES);
    expect(base64Bytes('AAEC')).toBe(3);
    expect(base64Bytes('AAE=')).toBe(2);
  });

  it('names an image by project, id and extension', () => {
    const id = crypto.randomUUID();
    expect(attachmentUrl('deck', { id, mimeType: 'image/jpeg' })).toBe(
      `/api/attachments/deck/${id}.jpg`,
    );
  });
});

describe('saveAttachments', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'qd-attach-')), 'attachments');
  });

  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('writes each image as <id>.<ext>, private, and returns references only', async () => {
    const refs = await saveAttachments(dir, [
      png(),
      { mimeType: 'image/jpeg', data: JPEG_DATA },
      { mimeType: 'image/gif', data: GIF_DATA },
      { mimeType: 'image/webp', data: WEBP_DATA },
    ]);
    expect(refs.map(({ path }) => path.slice(dir.length + 38))).toEqual([
      'png',
      'jpg',
      'gif',
      'webp',
    ]);
    const [first] = refs;
    expect(first).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      path: join(dir, `${first?.id}.png`),
    });
    expect(await readFile(first?.path ?? '')).toEqual(
      Buffer.from(PNG_DATA, 'base64'),
    );
    if (!IS_WINDOWS) {
      expect((await stat(first?.path ?? '')).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    await removeAttachments(refs);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses bytes that are not the image type they claim, and writes nothing', async () => {
    const saving = saveAttachments(dir, [
      png(),
      { mimeType: 'image/png', data: JPEG_DATA },
    ]);
    await expect(saving).rejects.toBeInstanceOf(AttachmentError);
    await expect(saving).rejects.toThrow(
      'Image 2 is not a valid image/png file.',
    );
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks the size again on the server', async () => {
    await expect(saveAttachments(dir, [oversized()])).rejects.toThrow(
      `Image 1: ${ATTACHMENT_SIZE_REFUSAL}`,
    );
  });

  it('makes no folder for a message without images', async () => {
    expect(await saveAttachments(dir, [])).toEqual([]);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('planPrompt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qd-prompt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends text alone when nothing is attached', async () => {
    expect(await planPrompt('hello', [], true)).toEqual({
      record: 'hello',
      input: 'hello',
    });
  });

  it('sends image blocks to an agent that takes images, and records only references', async () => {
    const [ref] = await saveAttachments(dir, [png()]);
    if (!ref) throw new Error('no image was saved');
    const plan = await planPrompt('look', [ref], true);
    expect(plan.input).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: PNG_DATA },
    ]);
    expect(plan.record).toBe(
      `look\n\n[image ${ref.id}: image/png, ${PNG_BYTES} bytes]`,
    );
    expect(plan.record).not.toContain(PNG_DATA);
  });

  it('sends a path line per image to an agent that does not', async () => {
    const [ref] = await saveAttachments(dir, [png()]);
    if (!ref) throw new Error('no image was saved');
    const text = `look\n\n${ATTACHED_PATHS_INTRO}\n- ${ref.path} (image/png, ${PNG_BYTES} bytes)`;
    expect(await planPrompt('look', [ref], false)).toEqual({
      record: text,
      input: text,
    });
    expect((await planPrompt('', [ref], true)).input).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG_DATA },
    ]);
  });
});
