import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { isRecord } from './agent-actions.js';

export const PAUSE_HELD_KIND = 'pause.held';

const SETTLING_KINDS: ReadonlySet<string> = new Set([
  'pause.replayed',
  'pause.dropped',
]);

export interface HeldWorkView {
  eventId: number;
  label: string;
  scopes: string[];
  text: string;
}

const heldEventIdOf = ({ payload }: StreamEvent): unknown => {
  if (!isRecord(payload)) return null;
  return payload['heldEventId'];
};

const settledIds = (events: readonly StreamEvent[]): Set<number> =>
  new Set(
    events
      .filter(({ kind }) => SETTLING_KINDS.has(kind))
      .map(heldEventIdOf)
      .filter((id): id is number => typeof id === 'number'),
  );

const scopesOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is string => typeof scope === 'string');
};

const heldText = (label: string, scopes: readonly string[]): string => {
  if (scopes.length === 0) return `held: ${label}`;
  return `held: ${label} (${scopes.join(', ')})`;
};

const heldView = (event: StreamEvent): HeldWorkView | null => {
  const { payload } = event;
  if (!isRecord(payload) || typeof payload['label'] !== 'string') return null;
  const { label } = payload;
  const scopes = scopesOf(payload['scopes']);
  return { eventId: event.id, label, scopes, text: heldText(label, scopes) };
};

export const heldWorkBy = (
  events: readonly StreamEvent[],
): Map<string, HeldWorkView[]> => {
  const settled = settledIds(events);
  const held = new Map<string, HeldWorkView[]>();
  events
    .filter(
      (event) =>
        event.kind === PAUSE_HELD_KIND &&
        event.agentId !== null &&
        !settled.has(event.id),
    )
    .toSorted((a, b) => a.id - b.id)
    .forEach((event) => {
      const view = heldView(event);
      const agentId = event.agentId ?? '';
      if (view === null) return;
      held.set(agentId, [...(held.get(agentId) ?? []), view]);
    });
  return held;
};
