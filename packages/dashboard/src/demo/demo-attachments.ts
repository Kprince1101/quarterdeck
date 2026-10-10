import {
  ATTACHMENT_PATH_PREFIX,
  attachmentFileName,
  base64Bytes,
  type AttachmentRef,
  type AttachmentUpload,
} from '@quarterdeck/server/intents';

const DEMO_ATTACHMENTS_DIR = '~/.quarterdeck/harbor/attachments';

export interface DemoAttachments {
  save: (uploads: readonly AttachmentUpload[]) => AttachmentRef[];
  serve: (pathname: string) => Response | null;
}

const bytesOf = (data: string): Blob =>
  new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))]);

export const createDemoAttachments = (newId: () => string): DemoAttachments => {
  const files = new Map<string, AttachmentUpload>();
  return {
    save: (uploads) =>
      uploads.map((upload) => {
        const id = newId();
        const name = attachmentFileName({ id, mimeType: upload.mimeType });
        files.set(name, upload);
        return {
          id,
          mimeType: upload.mimeType,
          bytes: base64Bytes(upload.data),
          path: `${DEMO_ATTACHMENTS_DIR}/${name}`,
        };
      }),
    serve: (pathname) => {
      if (!pathname.startsWith(ATTACHMENT_PATH_PREFIX)) return null;
      const name = pathname.split('/').at(-1) ?? '';
      const file = files.get(name);
      if (file === undefined) return new Response(null, { status: 404 });
      return new Response(bytesOf(file.data), {
        status: 200,
        headers: { 'content-type': file.mimeType },
      });
    },
  };
};
