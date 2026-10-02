export interface Results<T> {
  rows: T[];
}

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<Results<T>>;
  exec(sql: string): Promise<unknown>;
}

export type Unlisten = () => Promise<void>;

export interface LiveFeed {
  close(): Promise<void>;
  fail(err: Error): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  listen(
    channel: string,
    onPayload: (payload: string) => void,
  ): Promise<Unlisten>;
  close(): Promise<void>;
}
