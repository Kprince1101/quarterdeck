const CHUNK_BYTES = 0x8000;

export const bytesToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(start, start + CHUNK_BYTES)),
    );
  }
  return btoa(chunks.join(''));
};

export const dataUrl = (mimeType: string, base64: string): string =>
  `data:${mimeType};base64,${base64}`;
