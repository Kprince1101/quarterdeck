import { describe, expect, it } from 'vitest';
import { IntentError } from '../../../src/api/index.js';
import {
  BOARD_PROJECT_CAP,
  listedProjects,
  liveAgents,
  pauseFailure,
  pauseOutcome,
  projectLiveness,
  shownProjectIds,
  togglePick,
} from '../../../src/widgets/board/board-model.js';
import { agent, agentId, project, projectId } from './fixtures.js';

const ARCHIVED = '2026-09-30T12:00:00.000Z';

const PROJECTS = [
  project(1, 'Delta'),
  project(2, 'alpha'),
  project(3, 'Charlie', { archivedAt: ARCHIVED }),
  project(4, 'Bravo'),
];

describe('board projects', () => {
  it('lists projects by name and hides archived ones unless asked', () => {
    expect(listedProjects(PROJECTS, false).map(({ name }) => name)).toEqual([
      'alpha',
      'Bravo',
      'Delta',
    ]);
    expect(listedProjects(PROJECTS, true).map(({ name }) => name)).toEqual([
      'alpha',
      'Bravo',
      'Charlie',
      'Delta',
    ]);
  });

  it('shows the first projects up to the cap until some are picked', () => {
    const many = Array.from({ length: 6 }, (_, n) => project(n + 1, `p${n}`));
    expect(shownProjectIds(many, null)).toHaveLength(BOARD_PROJECT_CAP);
    expect(shownProjectIds(many, null, 2)).toEqual([
      projectId(1),
      projectId(2),
    ]);
    expect(shownProjectIds(many, [projectId(6), projectId(3)])).toEqual([
      projectId(3),
      projectId(6),
    ]);
  });

  it('drops picked projects that are no longer listed', () => {
    const listed = listedProjects(PROJECTS, false);
    expect(shownProjectIds(listed, [projectId(3), projectId(4)])).toEqual([
      projectId(4),
    ]);
  });

  it('toggles a pick but never past the cap', () => {
    const shown = [projectId(1), projectId(2)];
    expect(togglePick(shown, projectId(1), 2)).toEqual([projectId(2)]);
    expect(togglePick(shown, projectId(3), 2)).toEqual(shown);
    expect(togglePick(shown, projectId(3), 3)).toEqual([
      ...shown,
      projectId(3),
    ]);
  });
});

describe('board liveness', () => {
  const AGENTS = [
    agent(1, 1, { name: 'wren', role: 'builder', status: 'working' }),
    agent(2, 1, { name: 'heron', role: 'reviewer', status: 'idle' }),
    agent(3, 1, { name: 'kite', role: 'builder', status: 'ended' }),
    agent(4, 1, { name: 'owl', role: 'driver', status: 'paused' }),
    agent(5, 1, { name: 'crow', role: 'builder', status: 'stuck' }),
    agent(6, 2, { name: 'gull', role: 'builder', status: 'working' }),
    agent(7, 1, { name: 'lark', role: 'builder', status: 'retired' }),
  ];

  it('keeps live agents of one project, by role then name', () => {
    expect(liveAgents(AGENTS, projectId(1))).toEqual([
      {
        id: agentId(4),
        name: 'owl',
        role: 'driver',
        status: 'paused',
        label: 'owl, driver, paused',
      },
      {
        id: agentId(2),
        name: 'heron',
        role: 'reviewer',
        status: 'idle',
        label: 'heron, reviewer, idle',
      },
      {
        id: agentId(5),
        name: 'crow',
        role: 'builder',
        status: 'stuck',
        label: 'crow, builder, stuck',
      },
      {
        id: agentId(1),
        name: 'wren',
        role: 'builder',
        status: 'working',
        label: 'wren, builder, working',
      },
    ]);
  });

  it('describes each shown project in the order it is shown', () => {
    const projects = [
      project(1, 'Deck', { pausedAt: ARCHIVED }),
      project(2, 'Yard', { archivedAt: ARCHIVED }),
      project(3, 'Quiet'),
    ];
    const lanes = projectLiveness(
      projects,
      [projectId(3), projectId(2), projectId(1), projectId(9)],
      AGENTS,
    );
    expect(
      lanes.map(({ name, isPaused, isArchived, hasAgents, agentsLabel }) => ({
        name,
        isPaused,
        isArchived,
        hasAgents,
        agentsLabel,
      })),
    ).toEqual([
      {
        name: 'Quiet',
        isPaused: false,
        isArchived: false,
        hasAgents: false,
        agentsLabel: 'Quiet agents',
      },
      {
        name: 'Yard',
        isPaused: false,
        isArchived: true,
        hasAgents: true,
        agentsLabel: 'Yard agents',
      },
      {
        name: 'Deck',
        isPaused: true,
        isArchived: false,
        hasAgents: true,
        agentsLabel: 'Deck agents',
      },
    ]);
  });
});

describe('pause all outcome', () => {
  it('counts the projects the server reached', () => {
    expect(
      pauseOutcome(true, { paused: true, projects: ['a', 'b'], failed: [] }),
    ).toEqual({ tone: 'done', text: 'Paused 2 projects.' });
    expect(
      pauseOutcome(false, { paused: false, projects: ['a'], failed: [] }),
    ).toEqual({ tone: 'done', text: 'Resumed 1 project.' });
  });

  it('names the projects it could not reach', () => {
    expect(
      pauseOutcome(true, {
        paused: true,
        projects: ['a'],
        failed: [
          { project: 'b', error: 'locked' },
          { project: 'c', error: 'gone' },
        ],
      }),
    ).toEqual({
      tone: 'failed',
      text: 'Paused 1 project. Not reached: b (locked), c (gone).',
    });
  });

  it('falls back to a plain line for a result it cannot read', () => {
    expect(pauseOutcome(false, null)).toEqual({
      tone: 'done',
      text: 'Resumed everywhere.',
    });
  });

  it('reports a refused or failed request', () => {
    const refused = new IntentError(
      'pause.all',
      500,
      { error: 'Internal error' },
      true,
    );
    expect(pauseFailure(true, refused)).toEqual({
      tone: 'failed',
      text: 'Could not pause all: Internal error',
    });
    expect(pauseFailure(false, 'nope').text).toBe(
      'Could not resume all: Unknown error',
    );
  });
});
