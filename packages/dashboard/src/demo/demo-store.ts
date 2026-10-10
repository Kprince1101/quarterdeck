import type {
  KeepAwakeState,
  MachineState,
  SavedLayout,
  SnapshotMessage,
  SnapshotTables,
  StreamEvent,
  StreamMessage,
  StreamTable,
  Workspace,
} from '@quarterdeck/server/stream-schema';
import { emptyTables } from '../api/stream-state.js';

export type JsonValue = StreamEvent['payload'];

export const DEMO_STREAM_TAIL = 200;

export type DemoRow<Table extends StreamTable> = SnapshotTables[Table][number];

export type DemoListener = (message: StreamMessage) => void;

export interface DemoEventFields {
  agentId?: string | null;
  ticketId?: string | null;
  payload?: JsonValue;
}

export interface DemoStore {
  readonly projectId: string;
  now: () => string;
  newId: () => string;
  rows: <Table extends StreamTable>(table: Table) => DemoRow<Table>[];
  find: <Table extends StreamTable>(
    table: Table,
    id: DemoRow<Table>['id'],
  ) => DemoRow<Table> | undefined;
  put: <Table extends StreamTable>(table: Table, row: DemoRow<Table>) => void;
  patch: <Table extends StreamTable>(
    table: Table,
    id: DemoRow<Table>['id'],
    fields: Partial<DemoRow<Table>>,
  ) => DemoRow<Table> | undefined;
  remove: <Table extends StreamTable>(
    table: Table,
    id: DemoRow<Table>['id'],
  ) => void;
  emit: (kind: string, fields?: DemoEventFields) => StreamEvent;
  events: () => readonly StreamEvent[];
  machine: () => MachineState;
  setMachine: (machine: MachineState) => void;
  layout: () => SavedLayout | null;
  setLayout: (spec: SavedLayout['spec']) => SavedLayout;
  workspace: () => Workspace | null;
  keepAwake: () => KeepAwakeState;
  setKeepAwake: (keepAwake: KeepAwakeState) => void;
  reset: () => void;
  connect: (after: number | null, listener: DemoListener) => () => void;
}

export interface DemoStoreOptions {
  projectId: string;
  now?: () => number;
  workspace?: Workspace | null;
}

export const DEMO_KEEP_AWAKE_OFF: KeepAwakeState = {
  on: false,
  mode: null,
  expiresAt: null,
  available: true,
  unavailableReason: null,
};

const ID_PREFIX = '00000000-0000-4000-8000-';
const ID_DIGITS = 12;

export const demoId = (n: number): string =>
  `${ID_PREFIX}${String(n).padStart(ID_DIGITS, '0')}`;

export const createDemoStore = ({
  projectId,
  now = Date.now,
  workspace = null,
}: DemoStoreOptions): DemoStore => {
  const tables: SnapshotTables = emptyTables();
  const log: StreamEvent[] = [];
  const listeners = new Set<DemoListener>();
  let ids = 0;
  let lastEventId = 0;
  let wipedThrough = 0;
  let machine: MachineState = { pausedAt: null };
  let layout: SavedLayout | null = null;
  let keepAwake = DEMO_KEEP_AWAKE_OFF;

  const broadcast = (message: StreamMessage): void => {
    listeners.forEach((listener) => listener(message));
  };

  const rows = <Table extends StreamTable>(table: Table) =>
    tables[table] as DemoRow<Table>[];

  const find: DemoStore['find'] = (table, id) =>
    rows(table).find((row) => row.id === id);

  const change = <Table extends StreamTable>(
    table: Table,
    id: DemoRow<Table>['id'],
    row: DemoRow<Table> | null,
    op: 'insert' | 'update' | 'delete',
  ): void => {
    broadcast({ type: 'change', table, op, id, row } as StreamMessage);
  };

  const put: DemoStore['put'] = (table, row) => {
    const list = rows(table);
    const index = list.findIndex((existing) => existing.id === row.id);
    if (index === -1) {
      list.push(row);
      change(table, row.id, row, 'insert');
      return;
    }
    list[index] = row;
    change(table, row.id, row, 'update');
  };

  const store: DemoStore = {
    projectId,
    now: () => new Date(now()).toISOString(),
    newId: () => {
      ids += 1;
      return demoId(ids);
    },
    rows,
    find,
    put,
    patch: (table, id, fields) => {
      const row = find(table, id);
      if (row === undefined) return undefined;
      const next = { ...row, ...fields };
      put(table, next);
      return next;
    },
    remove: (table, id) => {
      const list = rows(table);
      const index = list.findIndex((row) => row.id === id);
      if (index === -1) return;
      list.splice(index, 1);
      if (table === 'agents') {
        tables.turns = tables.turns.filter((turn) => turn.agentId !== id);
      }
      change(table, id, null, 'delete');
    },
    emit: (kind, fields = {}) => {
      lastEventId += 1;
      const event: StreamEvent = {
        id: lastEventId,
        projectId,
        agentId: fields.agentId ?? null,
        ticketId: fields.ticketId ?? null,
        kind,
        payload: fields.payload ?? {},
        createdAt: store.now(),
      };
      log.push(event);
      broadcast({ type: 'event', event });
      return event;
    },
    events: () => log,
    machine: () => machine,
    setMachine: (next) => {
      machine = next;
      broadcast({ type: 'machine', machine });
    },
    layout: () => layout,
    workspace: () => workspace,
    keepAwake: () => keepAwake,
    setKeepAwake: (next) => {
      keepAwake = next;
      broadcast({ type: 'keepAwake', keepAwake });
    },
    setLayout: (spec) => {
      const saved = { spec, updatedAt: store.now() };
      layout = saved;
      broadcast({ type: 'layout', layout: saved });
      return saved;
    },
    reset: () => {
      Object.assign(tables, emptyTables());
      log.length = 0;
      wipedThrough = lastEventId;
      broadcast({
        type: 'snapshot',
        cursor: lastEventId,
        tables: emptyTables(),
        machine,
        layout,
        workspace,
        keepAwake,
      });
    },
    connect: (after, listener) => {
      const cursor =
        after ?? Math.max(wipedThrough, lastEventId - DEMO_STREAM_TAIL);
      const snapshot: SnapshotMessage = {
        type: 'snapshot',
        cursor,
        tables: structuredClone(tables),
        machine,
        layout,
        workspace,
        keepAwake,
      };
      listener(snapshot);
      log
        .filter((event) => event.id > cursor)
        .forEach((event) => listener({ type: 'event', event }));
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
};
