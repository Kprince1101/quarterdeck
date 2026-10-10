// @vitest-environment happy-dom
import {
  ATTACHMENT_COUNT_REFUSAL,
  ATTACHMENT_SIZE_REFUSAL,
  ATTACHMENT_TYPE_REFUSAL,
} from '@quarterdeck/server/intents';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ATTACH_ACCEPT,
  ChatInput,
  checkFiles,
  type ChatSubmit,
} from '../../src/primitives/index.js';
import {
  click,
  find,
  findAll,
  mount,
  press,
  typeInto,
  valueOf,
  type DomElement,
  type Mounted,
} from './dom.js';
import {
  JPEG_DATA,
  PNG_DATA,
  dragFilesOver,
  dropFiles,
  imageFile,
  pasteFiles,
  settleReads,
  sizedFile,
} from './files.js';

const mounted: Mounted[] = [];

const mountChat = (onSubmit: ChatSubmit) => {
  const view = mount(
    <ChatInput label="Message the Planner" onSubmit={onSubmit} />,
  );
  mounted.push(view);
  const field = find(view.container, 'textarea');
  const form = find(view.container, 'form');
  const send = find(view.container, 'button[type="submit"]');
  return { ...view, field, form, send };
};

const thumbs = (scope: DomElement): DomElement[] => [
  ...findAll(scope, '[aria-label="Attached images"] img'),
];

const alertText = (scope: DomElement): string | null =>
  scope.querySelector('[role="alert"]')?.textContent ?? null;

describe('ChatInput attachments', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    mounted.splice(0).forEach(({ unmount }) => unmount());
  });

  it('takes a pasted screenshot and a dropped file as two thumbnails, removes one, and sends the rest', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { container, field, form, send } = mountChat(onSubmit);

    const pasted = await pasteFiles(field, [
      imageFile('screenshot.png', 'image/png'),
    ]);
    expect(pasted.defaultPrevented).toBe(true);
    const over = await dragFilesOver(form, [
      imageFile('photo.jpg', 'image/jpeg', JPEG_DATA),
    ]);
    expect(over.defaultPrevented).toBe(true);
    expect(form.getAttribute('data-dragging')).toBe('true');
    const dropped = await dropFiles(form, [
      imageFile('photo.jpg', 'image/jpeg', JPEG_DATA),
    ]);
    expect(dropped.defaultPrevented).toBe(true);
    await settleReads();

    expect(form.getAttribute('data-dragging')).toBe('false');
    expect(thumbs(container).map((img) => img.getAttribute('src'))).toEqual([
      `data:image/png;base64,${PNG_DATA}`,
      `data:image/jpeg;base64,${JPEG_DATA}`,
    ]);
    expect(valueOf(field)).toBe('');
    expect(send.hasAttribute('disabled')).toBe(false);

    await click(find(container, '[aria-label="Remove attached image 1"]'));
    expect(thumbs(container).map((img) => img.getAttribute('alt'))).toEqual([
      'Attached image 1',
    ]);

    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('', [
      { mimeType: 'image/jpeg', data: JPEG_DATA },
    ]);
    expect(thumbs(container)).toHaveLength(0);
  });

  it('sends text and images together', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { field } = mountChat(onSubmit);
    await pasteFiles(field, [imageFile('a.png', 'image/png')]);
    await settleReads();
    typeInto(field, 'what is wrong here?');
    await press(field, 'Enter');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('what is wrong here?', [
      { mimeType: 'image/png', data: PNG_DATA },
    ]);
  });

  it('refuses another file type and an image over 5 MB with a clear message', async () => {
    const onSubmit = vi.fn<ChatSubmit>();
    const { container, field, form } = mountChat(onSubmit);

    await dropFiles(form, [imageFile('diagram.svg', 'image/svg+xml')]);
    await settleReads();
    expect(alertText(container)).toBe(
      `diagram.svg: ${ATTACHMENT_TYPE_REFUSAL}`,
    );
    expect(thumbs(container)).toHaveLength(0);

    await pasteFiles(field, [
      sizedFile('huge.png', 'image/png', 5 * 1024 * 1024 + 1),
      imageFile('ok.png', 'image/png'),
    ]);
    await settleReads();
    expect(alertText(container)).toBe(`huge.png: ${ATTACHMENT_SIZE_REFUSAL}`);
    expect(thumbs(container)).toHaveLength(1);
    expect(field.getAttribute('aria-invalid')).toBe('true');

    await click(find(container, '[aria-label="Remove attached image 1"]'));
    expect(alertText(container)).toBeNull();
  });

  it('holds at most five images', async () => {
    const { container, field } = mountChat(vi.fn());
    await pasteFiles(
      field,
      Array.from({ length: 6 }, (_, n) => imageFile(`${n}.png`, 'image/png')),
    );
    await settleReads();
    expect(thumbs(container)).toHaveLength(5);
    expect(alertText(container)).toBe(ATTACHMENT_COUNT_REFUSAL);
  });

  it('shows a thumbnail full size and closes it with Escape or Close', async () => {
    const { container, field } = mountChat(vi.fn());
    await pasteFiles(field, [imageFile('a.png', 'image/png')]);
    await settleReads();

    await click(
      find(container, '[aria-label="View Attached image 1 full size"]'),
    );
    const viewer = find(container, '[role="dialog"]');
    expect(viewer.getAttribute('aria-label')).toBe('Attached image 1');
    expect(find(viewer, 'img').getAttribute('src')).toBe(
      `data:image/png;base64,${PNG_DATA}`,
    );
    await press(viewer, 'Escape');
    expect(findAll(container, '[role="dialog"]')).toHaveLength(0);

    await click(
      find(container, '[aria-label="View Attached image 1 full size"]'),
    );
    const close = findAll(container, '[role="dialog"] button').find(
      ({ textContent }) => textContent === 'Close',
    );
    if (close === undefined) throw new Error('no Close button');
    await click(close);
    expect(findAll(container, '[role="dialog"]')).toHaveLength(0);
  });

  it('opens the file picker from the attach button and takes what it picks', async () => {
    const { container } = mountChat(vi.fn());
    const picker = find(container, 'input[type="file"]');
    expect(picker.getAttribute('accept')).toBe(ATTACH_ACCEPT);
    const opened = vi.spyOn(picker, 'click');
    await click(find(container, '[aria-label="Attach images"]'));
    expect(opened).toHaveBeenCalledOnce();

    Object.defineProperty(picker, 'files', {
      configurable: true,
      value: [imageFile('picked.png', 'image/png')],
    });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }) as never);
    });
    await settleReads();
    expect(thumbs(container)).toHaveLength(1);
  });

  it('leaves a text paste alone when the clipboard has no files', async () => {
    const { container, field } = mountChat(vi.fn());
    await pasteFiles(field, []);
    expect(thumbs(container)).toHaveLength(0);
    expect(alertText(container)).toBeNull();
  });
});

describe('checkFiles', () => {
  const png = (name: string) => ({
    name,
    type: 'image/png',
    size: 10,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
  });

  it('accepts what fits and names every refusal', () => {
    const check = checkFiles(
      [png('a.png'), { ...png('b.gif'), type: 'text/plain' }, png('c.png')],
      4,
    );
    expect(check.accepted.map(({ name }) => name)).toEqual(['a.png']);
    expect(check.refusal).toBe(
      `b.gif: ${ATTACHMENT_TYPE_REFUSAL} ${ATTACHMENT_COUNT_REFUSAL}`,
    );
    const fits = checkFiles([png('a.png')], 0);
    expect(fits.accepted.map(({ name }) => name)).toEqual(['a.png']);
    expect(fits.refusal).toBeNull();
  });
});
