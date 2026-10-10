import { useRef, useState } from 'react';
import type { AttachmentUpload } from '@quarterdeck/server/intents';
import { getErrorMessage } from '../lib/errors.js';
import {
  checkFiles,
  readDraftImage,
  uploadsOf,
  type AttachableFile,
  type DraftImage,
} from './chat-attachments.js';
import type { ImageThumb } from './use-image-strip.js';

export interface ChatAttachments {
  thumbs: ImageThumb[];
  hasImages: boolean;
  isReading: boolean;
  refusal: string | null;
  uploads: AttachmentUpload[];
  add: (files: readonly AttachableFile[]) => void;
  clear: () => void;
}

const thumbOf = (
  image: DraftImage,
  index: number,
  remove: (key: string) => void,
): ImageThumb => ({
  key: image.key,
  src: image.src,
  alt: `Attached image ${index + 1}`,
  canRemove: true,
  removeLabel: `Remove attached image ${index + 1}`,
  handleRemove: () => {
    remove(image.key);
  },
});

export const useChatAttachments = (): ChatAttachments => {
  const [images, setImages] = useState<DraftImage[]>([]);
  const [reading, setReading] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const counter = useRef(0);

  const nextKey = (): string => {
    counter.current += 1;
    return `image-${counter.current}`;
  };

  const read = async (files: readonly AttachableFile[]): Promise<void> => {
    setReading((count) => count + files.length);
    try {
      const drafts = await Promise.all(
        files.map((file) => readDraftImage(file, nextKey())),
      );
      setImages((current) => [...current, ...drafts]);
    } catch (err) {
      setRefusal(getErrorMessage(err));
    } finally {
      setReading((count) => count - files.length);
    }
  };

  const remove = (key: string): void => {
    setImages((current) => current.filter((image) => image.key !== key));
    setRefusal(null);
  };

  return {
    thumbs: images.map((image, index) => thumbOf(image, index, remove)),
    hasImages: images.length > 0,
    isReading: reading > 0,
    refusal,
    uploads: uploadsOf(images),
    add: (files) => {
      if (files.length === 0) return;
      const check = checkFiles(files, images.length + reading);
      setRefusal(check.refusal);
      if (check.accepted.length > 0) void read(check.accepted);
    },
    clear: () => {
      setImages([]);
      setRefusal(null);
    },
  };
};
