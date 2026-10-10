import { useState, type KeyboardEvent } from 'react';

export interface ImageThumb {
  key: string;
  src: string;
  alt: string;
  canRemove: boolean;
  removeLabel: string;
  handleRemove: () => void;
}

export interface ImageThumbView extends ImageThumb {
  viewLabel: string;
  handleView: () => void;
}

export interface ImageStripView {
  thumbs: ImageThumbView[];
  viewing: ImageThumb | null;
  handleClose: () => void;
  handleViewerKeyDown: (event: KeyboardEvent) => void;
}

export const viewLabel = (alt: string): string => `View ${alt} full size`;

export const useImageStrip = (
  images: readonly ImageThumb[],
): ImageStripView => {
  const [viewingKey, setViewingKey] = useState<string | null>(null);
  const close = (): void => {
    setViewingKey(null);
  };
  return {
    thumbs: images.map((image) => ({
      ...image,
      viewLabel: viewLabel(image.alt),
      handleView: () => {
        setViewingKey(image.key);
      },
    })),
    viewing: images.find(({ key }) => key === viewingKey) ?? null,
    handleClose: close,
    handleViewerKeyDown: (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    },
  };
};

export const NO_REMOVE = (): void => undefined;

export const viewOnlyThumb = (
  key: string,
  src: string,
  alt: string,
): ImageThumb => ({
  key,
  src,
  alt,
  canRemove: false,
  removeLabel: '',
  handleRemove: NO_REMOVE,
});
