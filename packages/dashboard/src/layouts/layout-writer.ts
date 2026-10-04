export interface SendOptions {
  keepalive: boolean;
}

export interface LayoutWrite {
  key: string;
  send: (options: SendOptions) => Promise<unknown>;
}

export interface LayoutWriterOptions {
  delayMs: number;
  onError: (err: unknown) => void;
}

export interface LayoutWriter {
  write: (write: LayoutWrite) => void;
  flush: (options?: SendOptions) => void;
  setReady: (ready: boolean) => void;
  hasQueued: () => boolean;
  isEcho: (key: string) => boolean;
}

const IN_PAGE: SendOptions = { keepalive: false };

export const createLayoutWriter = ({
  delayMs,
  onError,
}: LayoutWriterOptions): LayoutWriter => {
  const awaitingEcho: string[] = [];
  let queued: LayoutWrite | null = null;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;

  const sendOne = async (
    { key, send }: LayoutWrite,
    options: SendOptions,
  ): Promise<void> => {
    awaitingEcho.push(key);
    try {
      await send(options);
    } catch (err) {
      awaitingEcho.splice(awaitingEcho.lastIndexOf(key), 1);
      onError(err);
    }
  };

  const drain = async (options: SendOptions): Promise<void> => {
    const next = queued;
    if (next === null || !ready) {
      sending = false;
      return;
    }
    queued = null;
    sending = true;
    await sendOne(next, options);
    return drain(IN_PAGE);
  };

  const sendBeforeLeaving = (options: SendOptions): void => {
    const next = queued;
    if (next === null || !ready) return;
    queued = null;
    void sendOne(next, options);
  };

  const flush = (options = IN_PAGE): void => {
    clearTimeout(timer);
    timer = undefined;
    if (!sending) void drain(options);
    else if (options.keepalive) sendBeforeLeaving(options);
  };

  return {
    write: (write) => {
      queued = write;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    setReady: (next) => {
      ready = next;
      if (timer === undefined) flush();
    },
    hasQueued: () => queued !== null,
    isEcho: (key) => {
      const index = awaitingEcho.indexOf(key);
      if (index === -1) return false;
      awaitingEcho.splice(0, index + 1);
      return true;
    },
  };
};
