import { act } from 'react';
import { dom, type DomElement } from './dom.js';

export const PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const JPEG_DATA = '/9j/4AAQSkZJRgABAQ==';

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export const imageFile = (
  name: string,
  type: string,
  base64: string = PNG_DATA,
): File => new File([bytesOf(base64)], name, { type });

export const sizedFile = (name: string, type: string, size: number): File => {
  const file = imageFile(name, type);
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

const fireWith = async (
  target: DomElement,
  type: string,
  property: 'clipboardData' | 'dataTransfer',
  value: unknown,
): Promise<Event> => {
  const event = new (dom().Event)(type, {
    bubbles: true,
    cancelable: true,
  }) as unknown as Event;
  Object.defineProperty(event, property, { value });
  await act(async () => {
    target.dispatchEvent(event as never);
  });
  return event;
};

export const pasteFiles = (
  field: DomElement,
  files: readonly File[],
): Promise<Event> =>
  fireWith(field, 'paste', 'clipboardData', {
    types: ['Files'],
    files,
    getData: () => '',
  });

export const dragFilesOver = (
  target: DomElement,
  files: readonly File[],
): Promise<Event> =>
  fireWith(target, 'dragover', 'dataTransfer', {
    types: ['Files'],
    files,
    dropEffect: 'none',
  });

export const dropFiles = (
  target: DomElement,
  files: readonly File[],
): Promise<Event> =>
  fireWith(target, 'drop', 'dataTransfer', { types: ['Files'], files });

export const settleReads = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
};
