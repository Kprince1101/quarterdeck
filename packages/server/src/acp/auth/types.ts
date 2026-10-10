export type SignInStatus = 'starting' | 'waiting' | 'signed_in' | 'failed';

export interface SignInProgress {
  status: SignInStatus;
  url?: string;
  code?: string;
  message?: string;
}

export type SignInOutcome =
  { ok: true; via: string } | { ok: false; reason: string };

export interface SignInRunOptions {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  onProgress?: (progress: SignInProgress) => void;
  openUrl?: (url: string) => Promise<void>;
}

export type SignInDriver = (
  options?: SignInRunOptions,
) => Promise<SignInOutcome>;
