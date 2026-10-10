import type { JSX, KeyboardEvent } from 'react';
import './image-strip.css';
import {
  useImageStrip,
  type ImageThumb,
  type ImageThumbView,
} from './use-image-strip.js';

interface ImageViewerProps {
  image: ImageThumb | null;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

const ImageViewer = ({ image, onClose, onKeyDown }: ImageViewerProps) => {
  if (image === null) return null;
  return (
    <div
      className="qd-image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      onKeyDown={onKeyDown}
    >
      <img className="qd-image-viewer-image" src={image.src} alt={image.alt} />
      <button
        type="button"
        className="qd-image-viewer-close"
        autoFocus
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
};

interface ThumbProps {
  thumb: ImageThumbView;
}

const Thumb = ({ thumb }: ThumbProps) => (
  <li className="qd-image-thumb">
    <button
      type="button"
      className="qd-image-thumb-view"
      aria-label={thumb.viewLabel}
      onClick={thumb.handleView}
    >
      <img src={thumb.src} alt={thumb.alt} />
    </button>
    {thumb.canRemove && (
      <button
        type="button"
        className="qd-image-thumb-remove"
        aria-label={thumb.removeLabel}
        onClick={thumb.handleRemove}
      >
        ×
      </button>
    )}
  </li>
);

export interface ImageStripProps {
  label: string;
  images: readonly ImageThumb[];
}

export const ImageStrip = ({ label, images }: ImageStripProps): JSX.Element => {
  const view = useImageStrip(images);
  return (
    <>
      <ul className="qd-image-strip" aria-label={label}>
        {view.thumbs.map((thumb) => (
          <Thumb key={thumb.key} thumb={thumb} />
        ))}
      </ul>
      <ImageViewer
        image={view.viewing}
        onClose={view.handleClose}
        onKeyDown={view.handleViewerKeyDown}
      />
    </>
  );
};
