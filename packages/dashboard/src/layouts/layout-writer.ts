export interface LayoutWrite {
  key: string;
  send: () => Promise<unknown>;
}

export interface LayoutWriterOptions {
  delayMs: number;
  onError: (err: unknown) => void;
}

export interface LayoutWriter {
  write: (write: LayoutWrite) => void;
  flush: () => void;
  isEcho: (key: string) => boolean;
}

export const createLayoutWriter = ({
  delayMs,
  onError,
}: LayoutWriterOptions): LayoutWriter => {
  const awaitingEcho: string[] = [];
  let queued: LayoutWrite | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;

  const sendOne = async ({ key, send }: LayoutWrite): Promise<void> => {
    awaitingEcho.push(key);
    try {
      await send();
    } catch (err) {
      awaitingEcho.splice(awaitingEcho.lastIndexOf(key), 1);
      onError(err);
    }
  };

  const drain = async (): Promise<void> => {
    const next = queued;
    if (next === null) {
      sending = false;
      return;
    }
    queued = null;
    sending = true;
    await sendOne(next);
    return drain();
  };

  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (!sending) void drain();
  };

  return {
    write: (write) => {
      queued = write;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    isEcho: (key) => {
      const index = awaitingEcho.indexOf(key);
      if (index === -1) return false;
      awaitingEcho.splice(0, index + 1);
      return true;
    },
  };
};
