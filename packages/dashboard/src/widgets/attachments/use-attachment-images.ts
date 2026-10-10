import { useEffect, useState } from 'react';
import type { AttachmentReader } from '../../api/index.js';
import { useDeck } from '../../deck/DeckProvider.js';
import { viewOnlyThumb, type ImageThumb } from '../../primitives/index.js';
import {
  imageAlt,
  imagesKey,
  missingText,
  type MessageImage,
} from './message-images.js';

const FAILED = null;

type Loaded = ReadonlyMap<string, string | typeof FAILED>;

export interface AttachmentImagesView {
  thumbs: ImageThumb[];
  hasThumbs: boolean;
  hasMissing: boolean;
  missingText: string;
}

const sourceOf = (
  image: MessageImage,
  read: AttachmentReader,
): Promise<string | typeof FAILED> => {
  if (image.src !== null) return Promise.resolve(image.src);
  if (image.ref === null) return Promise.resolve(FAILED);
  return read(image.project, image.ref).catch(() => FAILED);
};

const loadAll = async (
  images: readonly MessageImage[],
  read: AttachmentReader,
): Promise<Loaded> =>
  new Map(
    await Promise.all(
      images.map(
        async (image) => [image.key, await sourceOf(image, read)] as const,
      ),
    ),
  );

export const useAttachmentImages = (
  images: readonly MessageImage[],
): AttachmentImagesView => {
  const { attachments } = useDeck();
  const [loaded, setLoaded] = useState<Loaded>(new Map());
  const signature = imagesKey(images);

  useEffect(() => {
    let current = true;
    void loadAll(images, attachments).then((next) => {
      if (current) setLoaded(next);
    });
    return () => {
      current = false;
    };
  }, [signature, attachments]);

  const thumbs = images.flatMap((image, index) => {
    const src = loaded.get(image.key);
    if (src === undefined || src === FAILED) return [];
    return [viewOnlyThumb(image.key, src, imageAlt(index))];
  });
  const missing = images.filter(
    ({ key }) => loaded.has(key) && loaded.get(key) === FAILED,
  ).length;
  return {
    thumbs,
    hasThumbs: thumbs.length > 0,
    hasMissing: missing > 0,
    missingText: missingText(missing),
  };
};
