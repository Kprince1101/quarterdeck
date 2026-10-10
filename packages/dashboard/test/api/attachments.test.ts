import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentReadError,
  createAttachmentReader,
} from '../../src/api/index.js';

const ID = '00000000-0000-4000-8000-0000000000d1';

describe('createAttachmentReader', () => {
  it('reads an image with the token and hands it back as a data URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    );
    const read = createAttachmentReader({
      baseUrl: 'http://127.0.0.1:4317',
      token: 'secret',
      fetch,
    });
    expect(await read('deck', { id: ID, mimeType: 'image/webp' })).toBe(
      'data:image/webp;base64,AQID',
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:4317/api/attachments/deck/${ID}.webp`,
      { headers: { authorization: 'Bearer secret' } },
    );
  });

  it('throws with the status when the server refuses', async () => {
    const read = createAttachmentReader({
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    const reading = read('deck', { id: ID, mimeType: 'image/png' });
    await expect(reading).rejects.toBeInstanceOf(AttachmentReadError);
    await expect(reading).rejects.toMatchObject({ status: 404 });
  });
});
