import { describe, expect, it } from 'vitest';
import {
  LOOKUP_NOTE,
  cardDeck,
  cardKind,
  cardOptions,
  splitLookupNote,
  withLookupNote,
} from '../../../src/widgets/cards/card-deck.js';
import {
  MINK,
  MINUTE,
  NOW,
  PROJECTS,
  STRAY,
  TICKET,
  agent,
  ago,
  askCard,
  card,
  cardId,
  mergeCard,
  signInCard,
  ticket,
} from './fixtures.js';

const deckOf = (cards: Parameters<typeof cardDeck>[0]['cards']) =>
  cardDeck({
    cards,
    projects: PROJECTS,
    agents: [agent(MINK, 'mink')],
    tickets: [ticket(TICKET, 'Cards widget')],
    now: NOW,
  });

describe('cardDeck', () => {
  it('is empty without cards', () => {
    expect(deckOf([])).toEqual({ open: [], answered: [], isEmpty: true });
  });

  it('lists open cards oldest first and settled ones newest first', () => {
    const deck = deckOf([
      card(1),
      card(5),
      card(3),
      card(10, {
        status: 'answered',
        answer: 'a',
        answeredAt: ago(8 * MINUTE),
      }),
      card(9, { status: 'declined', answeredAt: ago(2 * MINUTE) }),
      card(20, { status: 'expired', expiresAt: ago(4 * MINUTE) }),
    ]);
    expect(deck.open.map(({ id }) => id)).toEqual([
      cardId(5),
      cardId(3),
      cardId(1),
    ]);
    expect(
      deck.answered.map(({ id, statusLabel }) => [id, statusLabel]),
    ).toEqual([
      [cardId(9), 'Declined'],
      [cardId(20), 'Expired'],
      [cardId(10), 'Answered'],
    ]);
    expect(deck.isEmpty).toBe(false);
  });

  it('names the project, the asking agent and the ticket', () => {
    const [view] = deckOf([askCard(2)]).open;
    expect(view).toMatchObject({
      projectSlug: 'deck',
      project: 'Deck',
      from: 'mink',
      ticket: 'Cards widget',
      label: 'Question',
      askedAge: '2m ago',
      checkedLabel: 'Checked',
      recommendationLabel: 'Recommends',
      isCommand: false,
      canFlagLookup: true,
    });
  });

  it('falls back to ids when the project, agent or ticket is unknown', () => {
    const [view] = deckOf([
      card(1, {
        projectId: STRAY,
        agentId: cardId(900),
        ticketId: cardId(901),
      }),
    ]).open;
    expect(view).toMatchObject({
      projectSlug: null,
      project: STRAY,
      from: null,
      ticket: null,
    });
  });

  it('shows a sign-in card recommendation as the command to run', () => {
    const [view] = deckOf([signInCard(1)]).open;
    expect(view).toMatchObject({
      label: 'Sign in',
      checkedLabel: 'Why',
      recommendationLabel: 'Run',
      recommendation: 'claude /login',
      isCommand: true,
      options: ['Signed in'],
      canFlagLookup: false,
    });
  });

  it('gives a merge card its merge and hold choices and no lookup flag', () => {
    const [view] = deckOf([mergeCard(1)]).open;
    expect(view).toMatchObject({
      label: 'Merge',
      options: ['merge', 'hold'],
      ticket: 'Cards widget',
      canFlagLookup: false,
    });
  });

  it('offers the lookup flag only on free-text ask cards', () => {
    const deck = deckOf([
      askCard(1, { options: ['5173', '4317'] }),
      card(2, { kind: 'worktree.discard', options: [] }),
    ]);
    expect(deck.open.map(({ canFlagLookup }) => canFlagLookup)).toEqual([
      false,
      false,
    ]);
  });

  it('reads the lookup note back out of an answer', () => {
    const [view] = deckOf([
      askCard(1, {
        status: 'answered',
        answer: withLookupNote('5173', true),
        answeredAt: ago(0),
      }),
    ]).answered;
    expect(view).toMatchObject({ answer: '5173', lookup: true });
    expect(view?.settledAge).toBe('just now');
  });
});

describe('lookup note', () => {
  it('appends the note only when flagged', () => {
    expect(withLookupNote('5173', false)).toBe('5173');
    expect(withLookupNote('5173', true)).toBe(`5173\n\n${LOOKUP_NOTE}`);
  });

  it('splits it back off, and leaves other answers alone', () => {
    expect(splitLookupNote(withLookupNote('use 5173', true))).toEqual({
      text: 'use 5173',
      lookup: true,
    });
    expect(splitLookupNote(LOOKUP_NOTE)).toEqual({
      text: LOOKUP_NOTE,
      lookup: false,
    });
    expect(splitLookupNote(null)).toEqual({ text: null, lookup: false });
  });
});

describe('card helpers', () => {
  it('reads string options and ignores anything else', () => {
    expect(cardOptions(['a', 2, 'b', null])).toEqual(['a', 'b']);
    expect(cardOptions({ a: 1 })).toEqual([]);
    expect(cardOptions(null)).toEqual([]);
  });

  it('labels unknown kinds by their kind', () => {
    expect(cardKind('worktree.discard').label).toBe('worktree.discard');
  });
});
