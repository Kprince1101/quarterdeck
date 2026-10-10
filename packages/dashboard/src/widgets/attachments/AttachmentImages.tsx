import type { JSX } from 'react';
import { ImageStrip } from '../../primitives/index.js';
import type { MessageImage } from './message-images.js';
import { useAttachmentImages } from './use-attachment-images.js';

export interface AttachmentImagesProps {
  label: string;
  images: readonly MessageImage[];
}

export const AttachmentImages = ({
  label,
  images,
}: AttachmentImagesProps): JSX.Element => {
  const view = useAttachmentImages(images);
  return (
    <>
      {view.hasThumbs && <ImageStrip label={label} images={view.thumbs} />}
      {view.hasMissing && <p className="qd-empty">{view.missingText}</p>}
    </>
  );
};
