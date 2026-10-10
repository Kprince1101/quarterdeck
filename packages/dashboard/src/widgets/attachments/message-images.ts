import type { AttachmentRef } from '@quarterdeck/server/intents';

export interface MessageImage {
  key: string;
  project: string;
  ref: Pick<AttachmentRef, 'id' | 'mimeType'> | null;
  src: string | null;
}

export const storedImages = (
  project: string,
  refs: readonly Pick<AttachmentRef, 'id' | 'mimeType'>[],
): MessageImage[] =>
  refs.map((ref) => ({ key: ref.id, project, ref, src: null }));

export const localImages = (
  owner: string,
  sources: readonly string[],
): MessageImage[] =>
  sources.map((src, index) => ({
    key: `${owner}-${index}`,
    project: '',
    ref: null,
    src,
  }));

export const imageAlt = (index: number): string => `Image ${index + 1}`;

export const missingText = (count: number): string => {
  if (count === 1) return '1 image could not be loaded.';
  return `${count} images could not be loaded.`;
};

export const imagesKey = (images: readonly MessageImage[]): string =>
  images.map(({ key }) => key).join('|');
