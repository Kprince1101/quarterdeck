import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgeTerms } from '@quarterdeck/rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBusTools } from '../../src/bus/index.js';
import { wordedTools } from '../../src/bus/wording.js';
import {
  composeTurnInput,
  machineRules,
  projectNote,
  reviewBusLine,
  reviewerInput,
} from '../../src/crew/index.js';
import {
  buildAssignmentPrompt,
  buildBirthInput,
  driverTurnInstructions,
  wakePrompt,
  type Dependency,
  type ProjectBrief,
} from '../../src/driver/index.js';
import {
  decisionsNote,
  openingPrompt,
  repromptText,
} from '../../src/planner/brief.js';
import type { OpenProject } from '../../src/planner/projects.js';
import type { WorkspaceMode } from '../../src/stream/schema.js';
import { buildWrapUpPrompt } from '../../src/voyage-end/index.js';
import { FAKE_SPEC_BODY } from '../acp/fake-agent/index.ts';

const MODES: WorkspaceMode[] = ['single', 'multi'];

const TERMS = forgeTerms('github');

const SERVICES = {
  forge: { forge: 'github' as const, host: 'github.com' },
  tracker: null,
};

const BRIEF: ProjectBrief = {
  project: 'deck',
  repoPath: '/work/deck',
  bus: 'bus-deck',
  terms: TERMS,
  waiting: [{ id: 't-1', title: 'Fix the README greeting' }],
  builders: [
    {
      id: 'b-1',
      name: 'crane',
      status: 'working',
      ticket: { id: 't-2', title: 'Add a footer' },
    },
  ],
  services: SERVICES,
};

const NOTEBOOK = [
  {
    id: 'n-1',
    body: 'Run the store tests on both backends.',
    pinned: true,
    global: true,
    project: 'deck',
  },
  {
    id: 'n-2',
    body: 'The README is generated; edit its template.',
    pinned: false,
    global: false,
    project: 'deck',
  },
];

const DEPENDENCY: Dependency = {
  id: 't-0',
  project: 'deck',
  title: 'Add the template',
  status: 'done',
  publishes: false,
  published: null,
  satisfied: true,
  reason: null,
};

const OPEN_PROJECT: OpenProject = {
  slug: 'deck',
  name: 'Deck',
  repoPath: '/work/deck',
  archived: false,
  store: undefined as never,
};

const snapshotPath = (name: string, mode: WorkspaceMode): string =>
  `./__snapshots__/prompts/${name}.${mode}.md`;

const toolTexts = async (mode: WorkspaceMode): Promise<string> => {
  const tools = wordedTools(await loadBusTools(), TERMS, mode);
  return tools
    .map((tool) => `## ${tool.name}\n\n${tool.description}`)
    .join('\n\n');
};

const withoutTableList = (text: string): string =>
  text.replace(/Tables:\n[\s\S]*?(\n## |$)/, '$1');

describe('prompts in both workspace modes', () => {
  let homeDir: string;
  const prompts = new Map<string, string>();

  const generate = async (mode: WorkspaceMode) => {
    const rules = machineRules(homeDir, async () => mode);
    const [charter, reviewer] = await Promise.all([
      rules.load('charter'),
      rules.load('reviewer'),
    ]);
    const request = {
      ticket: { id: 't-1', title: 'Fix the README greeting', body: '' },
      reviewer: { id: 'r-1', name: 'heron' },
      builder: { id: 'b-1', name: 'crane' },
      pr: 'https://github.com/example/deck/pull/7',
      head: '0123456789abcdef0123456789abcdef01234567',
      notes: 'Tests pass.',
      terms: TERMS,
    };
    return {
      'driver-birth': buildBirthInput({
        agent: { name: 'osprey' },
        voyage: { number: 3, goal: 'Ship the greeting' },
        charter,
        notebook: NOTEBOOK,
        projects: [BRIEF],
        mode,
        instructions: driverTurnInstructions(mode),
      }),
      'driver-turn': composeTurnInput(
        [
          projectNote('deck', {
            text: 'Ticket approved: "Fix the README greeting" (ticket t-1). Assign it once its dependencies are done.',
            wake: 'event',
          }),
        ],
        mode,
      ),
      'builder-assignment': buildAssignmentPrompt({
        builder: { name: 'crane' },
        ticket: {
          id: 't-1',
          title: 'Fix the README greeting',
          body: FAKE_SPEC_BODY,
          prUrl: null,
          headSha: null,
          externalRef: null,
        },
        worktreePath: '/work/worktrees/crane-t-1',
        repoPath: '/work/deck',
        base: 'origin/main',
        terms: TERMS,
        services: SERVICES,
        mode,
      }),
      'builder-wake': wakePrompt(
        { id: 't-1', title: 'Fix the README greeting' },
        [DEPENDENCY],
        mode,
      ),
      reviewer: `${reviewerInput(reviewer, request, 'Services')}\n\n${reviewBusLine('deck', TERMS, mode)}`,
      'planner-opening': openingPrompt(
        charter,
        [OPEN_PROJECT],
        'Add a greeting to the README.',
        TERMS,
        mode,
      ),
      'planner-reprompt': repromptText(
        '- Greeting: it does not follow the format',
        TERMS,
        mode,
      ),
      'planner-decisions': decisionsNote(
        [
          {
            ticketId: 't-1',
            title: 'Fix the README greeting',
            status: 'open',
            project: 'deck',
          },
        ],
        mode,
      ),
      'driver-wrap-up': buildWrapUpPrompt({
        voyage: { number: 3 },
        charter,
        notebook: NOTEBOOK,
        mode,
      }),
      'bus-tools': await toolTexts(mode),
    };
  };

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-prompts-'));
    for (const mode of MODES) {
      for (const [name, text] of Object.entries(await generate(mode))) {
        prompts.set(`${name}.${mode}`, text);
      }
    }
  });

  afterAll(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const NAMES = [
    'driver-birth',
    'driver-turn',
    'builder-assignment',
    'builder-wake',
    'reviewer',
    'planner-opening',
    'planner-reprompt',
    'planner-decisions',
    'driver-wrap-up',
    'bus-tools',
  ];

  describe.each(MODES)('%s mode', (mode) => {
    it.each(NAMES)('%s matches its snapshot', async (name) => {
      await expect(prompts.get(`${name}.${mode}`)).toMatchFileSnapshot(
        snapshotPath(name, mode),
      );
    });
  });

  it.each(NAMES)(
    'never says project in the single-mode %s, nor its markers',
    (name) => {
      const text = withoutTableList(prompts.get(`${name}.single`) ?? '');
      expect(text).not.toMatch(/project/i);
      expect(text).not.toContain('<!--');
    },
  );

  it('keeps the cross-project affordances in multi mode only', () => {
    const multi = prompts.get('driver-birth.multi') ?? '';
    const single = prompts.get('driver-birth.single') ?? '';
    expect(multi).toContain('"kind": "block"');
    expect(multi).toContain('"kind": "published"');
    expect(multi).toContain('# Projects');
    expect(single).not.toContain('"kind": "block"');
    expect(single).not.toContain('"kind": "published"');
    expect(single).toContain('# Repository');
    expect(single).toContain('the Driver of this repository for voyage 3.');
    expect(multi).not.toContain('<!--');
  });

  it('builds both modes from the same charter, differing only where tagged', () => {
    const single = prompts.get('driver-birth.single') ?? '';
    const multi = prompts.get('driver-birth.multi') ?? '';
    const shared =
      'Every ticket ships with tests. A report without passing tests';
    expect(single).toContain(shared);
    expect(multi).toContain(shared);
  });
});
