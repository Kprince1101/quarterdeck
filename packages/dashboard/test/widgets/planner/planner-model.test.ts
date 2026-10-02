import { describe, expect, it } from 'vitest';
import {
  GONE_LABEL,
  chosenProject,
  conversation,
  currentConversation,
  payloadText,
  projectChoices,
  proposalOf,
  waitingMessages,
  type ConversationEntry,
  type PendingMessage,
} from '../../../src/widgets/planner/planner-model.js';
import {
  DECK,
  DOCS,
  INTENT_1,
  INTENT_2,
  PROJECTS,
  SHIP,
  SITE,
  cleared,
  human,
  plannerEvent,
  project,
  proposed,
  reply,
  ticket,
} from './fixtures.js';

const ARCHIVE = '00000000-0000-4000-8000-000000000009';

const summary = (entries: ConversationEntry[]): string[] =>
  entries.map(({ message, proposal }) => {
    if (proposal !== null) return `proposal: ${proposal.title}`;
    return `${message?.author}: ${message?.text}`;
  });

const waiting = (intentId: string, text = 'hello'): PendingMessage => ({
  projectId: DECK,
  intentId,
  text,
});

describe('payloadText', () => {
  it('reads a string field and nothing else', () => {
    expect(payloadText({ text: 'hi' }, 'text')).toBe('hi');
    expect(payloadText({ text: 3 }, 'text')).toBeNull();
    expect(payloadText(null, 'text')).toBeNull();
    expect(payloadText('text', 'text')).toBeNull();
  });
});

describe('project choices', () => {
  it('lists live projects by name and skips archived ones', () => {
    const archived = {
      ...project(ARCHIVE, 'Archive'),
      archivedAt: '2026-09-02T00:00:00.000Z',
    };
    const choices = projectChoices([
      project(SITE, 'Site'),
      archived,
      project(DECK, 'Deck'),
    ]);
    expect(choices).toEqual([
      { id: DECK, slug: 'deck', label: 'Deck' },
      { id: SITE, slug: 'site', label: 'Site' },
    ]);
  });

  it('falls back to the first project when nothing or a gone one is chosen', () => {
    const choices = projectChoices(PROJECTS);
    expect(chosenProject(choices, null)?.id).toBe(DECK);
    expect(chosenProject(choices, SITE)?.id).toBe(SITE);
    expect(chosenProject(choices, ARCHIVE)?.id).toBe(DECK);
    expect(chosenProject([], null)).toBeNull();
  });
});

describe('currentConversation', () => {
  it('keeps the project events after the last new or cleared', () => {
    const events = [
      human(1, 'old'),
      cleared(2),
      plannerEvent(3, 'planner.human', { projectId: SITE }),
      human(4, 'fresh'),
      plannerEvent(5, 'planner.new', { projectId: SITE }),
    ];
    expect(currentConversation(events, DECK).map(({ id }) => id)).toEqual([4]);
    expect(currentConversation(events, SITE)).toEqual([]);
  });

  it('starts a new conversation as soon as planner.new is recorded', () => {
    const events = [human(1, 'old'), plannerEvent(2, 'planner.new')];
    expect(currentConversation(events, DECK)).toEqual([]);
  });
});

describe('proposalOf', () => {
  it('describes a proposal from its ticket row', () => {
    const tickets = new Map([
      [SHIP, ticket(SHIP, 'Ship it', { body: 'all of it', dependsOn: [DOCS] })],
      [DOCS, ticket(DOCS, 'Write docs', { status: 'open' })],
    ]);
    expect(proposalOf(SHIP, 'Ship', tickets)).toEqual({
      ticketId: SHIP,
      title: 'Ship it',
      body: 'all of it',
      statusLabel: 'Proposed',
      isDecidable: true,
      dependsOn: [{ id: DOCS, title: 'Write docs' }],
    });
    expect(proposalOf(DOCS, 'Docs', tickets)).toMatchObject({
      statusLabel: 'Approved',
      isDecidable: false,
    });
  });

  it('labels rejected tickets and names unknown dependencies by id', () => {
    const tickets = new Map([
      [SHIP, ticket(SHIP, 'Ship', { status: 'rejected', dependsOn: [DOCS] })],
    ]);
    expect(proposalOf(SHIP, 'Ship', tickets)).toMatchObject({
      statusLabel: 'Rejected',
      isDecidable: false,
      dependsOn: [{ id: DOCS, title: DOCS }],
    });
  });

  it('keeps the proposed title when the ticket is gone', () => {
    expect(proposalOf(SHIP, 'Ship', new Map())).toEqual({
      ticketId: SHIP,
      title: 'Ship',
      body: '',
      statusLabel: GONE_LABEL,
      isDecidable: false,
      dependsOn: [],
    });
  });
});

describe('waitingMessages', () => {
  it('keeps a sent message until the Planner takes it or refuses it', () => {
    const pending = [waiting(INTENT_1), waiting(INTENT_2)];
    expect(waitingMessages(pending, [], DECK)).toEqual(pending);
    expect(
      waitingMessages(pending, [human(1, 'hello', INTENT_1)], DECK),
    ).toEqual([pending[1]]);
    const failed = plannerEvent(2, 'planner.failed', {
      payload: { intentId: INTENT_2, error: 'no repo' },
    });
    expect(waitingMessages(pending, [failed], DECK)).toEqual([pending[0]]);
  });

  it('drops a message a newer conversation superseded', () => {
    const recorded = plannerEvent(1, 'planner.message', {
      payload: { intentId: INTENT_1, status: 'pending' },
    });
    const pending = [waiting(INTENT_1)];
    expect(waitingMessages(pending, [recorded], DECK)).toEqual(pending);
    expect(waitingMessages(pending, [recorded, cleared(2)], DECK)).toEqual([]);
  });

  it('shows only the chosen project', () => {
    expect(waitingMessages([waiting(INTENT_1)], [], SITE)).toEqual([]);
  });
});

describe('conversation', () => {
  it('interleaves messages and proposals in event order, waiting ones last', () => {
    const events = [
      human(1, 'build a site'),
      proposed(2, SHIP, 'Ship'),
      plannerEvent(3, 'planner.message'),
      reply(4, 'Proposed one ticket.'),
      plannerEvent(5, 'planner.failed', {
        payload: { intentId: INTENT_2, error: 'agent died' },
      }),
      plannerEvent(6, 'ticket.proposed', { payload: { title: 'no ticket' } }),
    ];
    const entries = conversation({
      events,
      tickets: [ticket(SHIP, 'Ship it')],
      pending: [waiting('00000000-0000-4000-8000-0000000000c3', 'and docs')],
      projectId: DECK,
    });
    expect(summary(entries)).toEqual([
      'human: build a site',
      'proposal: Ship it',
      'planner: Proposed one ticket.',
      'failed: agent died',
      'pending: and docs',
    ]);
    expect(entries.map(({ key }) => key)).toEqual([
      'event-1',
      'event-2',
      'event-4',
      'event-5',
      'pending-00000000-0000-4000-8000-0000000000c3',
    ]);
    expect(entries[0]?.message?.authorLabel).toBe('You');
  });
});
