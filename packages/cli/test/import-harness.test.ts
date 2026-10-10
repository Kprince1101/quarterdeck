import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  PostgresSessionError,
  TICKETS_IMPORTED_EVENT,
  connectPostgresSession,
  createProjectStores,
  quarterdeckHome,
  readWorkspace,
  type Store,
} from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  dropDatabase,
  POSTGRES_URL,
} from '../../server/test/store/backends.js';
import {
  HARNESS_DATABASE_URL,
  IMPORT_USAGE,
  NOTEBOOK_IMPORTED_EVENT,
  main,
  readHarness,
  type HarnessConnector,
  type HarnessSession,
} from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const TIMEOUT = 60_000;

const PASSWORD = 's3cret-Pass';
const URL_WITH_SECRET = `postgres://importer:${PASSWORD}@db.example.test:5432/harness`;

const P_ALPHA = '00000000-0000-4000-8000-00000000a001';
const P_BETA = '00000000-0000-4000-8000-00000000b001';
const P_GAMMA = '00000000-0000-4000-8000-00000000c001';
const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const A3 = '00000000-0000-4000-8000-0000000000a3';
const B1 = '00000000-0000-4000-8000-0000000000b1';
const B2 = '00000000-0000-4000-8000-0000000000b2';
const G1 = '00000000-0000-4000-8000-0000000000c1';
const N1 = '00000000-0000-4000-8000-0000000000e1';
const N2 = '00000000-0000-4000-8000-0000000000e2';
const N3 = '00000000-0000-4000-8000-0000000000e3';

const HARNESS_SCHEMA = `
create table harness_projects (
  id uuid primary key,
  name text not null unique,
  repos text[] not null default '{}',
  auto_merge boolean not null default false,
  reviewer text,
  copilot_review boolean not null default true,
  paused boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create table docket_items (
  id uuid primary key,
  title text not null,
  description text,
  status text not null default 'proposed',
  context jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  project text not null default 'general',
  priority text not null default 'normal',
  depends_on uuid[] not null default '{}',
  pr_url text,
  pr_state text,
  parent_id uuid references docket_items (id)
);
create table harness_notebook (
  id uuid primary key,
  scope text not null,
  project uuid references harness_projects (id),
  key text not null,
  text text not null,
  pinned boolean not null default false,
  status text not null default 'proposed',
  created_at timestamptz not null
);`;

const HARNESS_ROWS = `
insert into harness_projects (id, name, repos, auto_merge, reviewer, copilot_review, paused, archived_at) values
  ('${P_ALPHA}', 'alpha', '{~/repos/alpha,~/repos/alpha-docs}', true, 'reviewer-one', true, false, null),
  ('${P_BETA}', 'beta', '{~/repos/beta}', false, 'reviewer-one', false, true, null),
  ('${P_GAMMA}', 'gamma', '{~/repos/gamma}', false, null, false, false, '2026-09-01T00:00:00Z');
insert into docket_items (id, project, title, description, status, priority, depends_on, parent_id, pr_url, pr_state, context, created_at) values
  ('${A1}', 'alpha', 'Build the widget', 'Make it spin.', 'approved', 'high', '{}', null, null, null, '{"area": "core"}', '2026-09-01T01:00:00Z'),
  ('${A2}', 'alpha', 'Ship the widget', null, 'in_review', 'normal', '{${A1}}', null, 'https://github.com/example/alpha/pull/7', 'open', null, '2026-09-01T02:00:00Z'),
  ('${A3}', 'alpha', 'Old work', null, 'completed', 'normal', '{}', null, null, null, null, '2026-09-01T03:00:00Z'),
  ('${B1}', 'beta', 'Wire the gauge', 'Needs the widget.', 'blocked', 'normal', '{${A2}}', null, null, null, null, '2026-09-01T04:00:00Z'),
  ('${G1}', 'gamma', 'Archived work', null, 'approved', 'normal', '{}', null, null, null, null, '2026-09-01T06:00:00Z');
insert into docket_items (id, project, title, description, status, priority, depends_on, parent_id, created_at) values
  ('${B2}', 'beta', 'Sketch the dial', null, 'proposed', 'low', '{${A3}}', '${B1}', '2026-09-01T05:00:00Z');
insert into harness_notebook (id, scope, project, key, text, pinned, status, created_at) values
  ('${N1}', 'project', '${P_ALPHA}', 'tests', 'Run the widget tests before pushing.', true, 'active', '2026-08-01T00:00:00Z'),
  ('${N2}', 'global', null, 'style', 'Keep pull requests small.', false, 'active', '2026-08-02T00:00:00Z'),
  ('${N3}', 'project', '${P_BETA}', 'old', 'A retired note.', false, 'retired', '2026-08-03T00:00:00Z');`;

interface FakeHarness {
  db: PGlite;
  urls: string[];
  statements: string[];
  connect: HarnessConnector;
}

const fakeHarness = async (): Promise<FakeHarness> => {
  const db = await PGlite.create();
  await db.exec(HARNESS_SCHEMA);
  await db.exec(HARNESS_ROWS);
  const urls: string[] = [];
  const statements: string[] = [];
  const session: HarnessSession = {
    query: async <T>(sql: string, params?: unknown[]) => {
      statements.push(sql);
      const { rows } = await db.query<T>(sql, params);
      return { rows };
    },
    close: async () => {
      await db.exec('set default_transaction_read_only = off');
    },
  };
  return {
    db,
    urls,
    statements,
    connect: (url) => {
      urls.push(url);
      return Promise.resolve(session);
    },
  };
};

const harnessIo = (box: Sandbox, harness: FakeHarness): TestIo => ({
  ...testIo(box.home),
  env: { [HARNESS_DATABASE_URL]: URL_WITH_SECRET },
  harness: harness.connect,
});

const run = (args: string[], io: TestIo) =>
  main(['import', 'harness', ...args], io);

const withStore = async <T>(
  home: string,
  project: string,
  use: (store: Store) => Promise<T>,
): Promise<T> => {
  const stores = createProjectStores(quarterdeckHome(home));
  try {
    return await use(await stores.get(project));
  } finally {
    await stores.closeAll();
  }
};

interface TicketRow {
  id: string;
  externalId: string;
  title: string;
  body: string;
  status: string;
  dependsOn: string[];
  prUrl: string | null;
  updatedAt: Date;
}

const ticketsIn = (home: string, project: string) =>
  withStore(home, project, async (store) => {
    const { rows } = await store.db.query<TicketRow>(
      `select id, external_id as "externalId", title, body, status,
         depends_on as "dependsOn", pr_url as "prUrl", updated_at as "updatedAt"
       from tickets where project_id = $1 and source = 'harness'
       order by external_id`,
      [store.projectId],
    );
    return rows;
  });

interface NoteRow {
  externalId: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
}

const notesIn = (home: string, project: string) =>
  withStore(home, project, async (store) => {
    const { rows } = await store.db.query<NoteRow>(
      `select external_id as "externalId", body, pinned, created_at as "createdAt"
       from notebook where project_id = $1 order by external_id`,
      [store.projectId],
    );
    return rows;
  });

const projectRow = (home: string, project: string) =>
  withStore(home, project, async (store) => {
    const { rows } = await store.db.query<{
      name: string;
      repoPath: string | null;
      paused: boolean;
    }>(
      `select name, repo_path as "repoPath", paused_at is not null as paused
       from projects where id = $1`,
      [store.projectId],
    );
    return rows[0];
  });

const eventCount = (home: string, project: string) =>
  withStore(home, project, async (store) => {
    const { rows } = await store.db.query<{ count: number }>(
      'select count(*)::int as count from events where project_id = $1',
      [store.projectId],
    );
    return rows[0]?.count ?? 0;
  });

const harnessCounts = async (db: PGlite) => {
  const { rows } = await db.query<{ count: number }>(
    `select (select count(*) from harness_projects)
       + (select count(*) from docket_items)
       + (select count(*) from harness_notebook) as count`,
  );
  return Number(rows[0]?.count);
};

const listProjects = async (home: string) => {
  const stores = createProjectStores(quarterdeckHome(home));
  try {
    return await stores.list();
  } finally {
    await stores.closeAll();
  }
};

const byExternal = (rows: readonly TicketRow[], id: string): TicketRow => {
  const row = rows.find((candidate) => candidate.externalId === id);
  if (!row) throw new Error(`no ticket for ${id}`);
  return row;
};

const output = (io: TestIo): string => [...io.lines, ...io.errors].join('\n');

describe('quarterdeck import harness', { timeout: TIMEOUT }, () => {
  let box: Sandbox;
  let harness: FakeHarness;

  beforeEach(async () => {
    box = await sandbox();
    await mkdir(join(box.home, 'repos', 'alpha', '.git'), { recursive: true });
    await mkdir(join(box.home, 'repos', 'beta', '.git'), { recursive: true });
    harness = await fakeHarness();
  });

  afterEach(async () => {
    await harness.db.close();
    await box.close();
  });

  it('dry-runs by default: prints every decision and writes nothing', async () => {
    const io = harnessIo(box, harness);

    expect(await run([], io)).toBe(0);

    const text = output(io);
    expect(text).toContain(
      'Read from Harness: 3 projects, 5 open docket items, 2 active notebook entries.',
    );
    expect(text).toContain('Project alpha (new), from Harness project "alpha"');
    expect(text).toContain(
      `also in Harness, not imported: ${join(box.home, 'repos', 'alpha-docs')}`,
    );
    expect(text).toContain('paused in Harness; created paused');
    expect(text).toContain(
      '  tickets: 2 to create, 0 to update, 0 unchanged, 0 left as they are',
    );
    expect(text).toContain(
      `ticket ${A2} "Ship the widget": create; in_review -> open (in flight in Harness; noted in the description); 1 dependency remapped`,
    );
    expect(text).toContain(
      `dependency on item ${A3} dropped: not imported (completed, or in a skipped project)`,
    );
    expect(text).toContain(
      'Skipped project "gamma": archived in Harness (pass --include-archived to import it).',
    );
    expect(text).toContain(
      'Reviewer in Harness for alpha, beta: reviewer-one. Reviewers are not imported as agents; set up the global reviewer yourself.',
    );
    expect(text).toContain(
      'mergeGate.requireAiReview true (copilot_review on in alpha); mergeGate.autoMerge false (auto_merge off in beta); to write.',
    );
    expect(io.lines.at(-1)).toBe(
      'Dry run: nothing written. Run again with --apply to import.',
    );
    expect(await listProjects(box.home)).toEqual([]);
    expect(await readWorkspace(quarterdeckHome(box.home))).toBeNull();
    await expect(
      readFile(
        join(quarterdeckHome(box.home), 'rules.local.lifecycle.json'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('takes --dry-run explicitly, and refuses it with --apply', async () => {
    const io = harnessIo(box, harness);
    expect(await run(['--dry-run'], io)).toBe(0);
    expect(io.lines.at(-1)).toContain('Dry run: nothing written.');
    expect(await listProjects(box.home)).toEqual([]);

    const both = harnessIo(box, harness);
    expect(await run(['--dry-run', '--apply'], both)).toBe(1);
    expect(both.errors).toEqual(['Pass --dry-run or --apply, not both']);
  });

  it('imports projects, tickets with remapped dependencies, notebook entries and rules', async () => {
    const io = harnessIo(box, harness);

    expect(await run(['--apply'], io)).toBe(0);

    expect(io.lines.at(-1)).toBe(
      'Imported: 2 projects created, 4 tickets created and 0 updated, 3 notebook entries created and 0 updated; rules written.',
    );
    expect(await listProjects(box.home)).toEqual(['alpha', 'beta']);
    expect(await projectRow(box.home, 'alpha')).toEqual({
      name: 'alpha',
      repoPath: join(box.home, 'repos', 'alpha'),
      paused: false,
    });
    expect(await projectRow(box.home, 'beta')).toEqual({
      name: 'beta',
      repoPath: join(box.home, 'repos', 'beta'),
      paused: true,
    });
    const workspace = await readWorkspace(quarterdeckHome(box.home));
    expect(workspace?.projects.map((project) => project.slug)).toEqual([
      'alpha',
      'beta',
    ]);

    const alpha = await ticketsIn(box.home, 'alpha');
    const beta = await ticketsIn(box.home, 'beta');
    expect(alpha.map((row) => row.externalId)).toEqual([A1, A2]);
    expect(beta.map((row) => row.externalId)).toEqual([B1, B2]);

    const build = byExternal(alpha, A1);
    expect(build.status).toBe('open');
    expect(build.body).toContain('Make it spin.\n\n---\n');
    expect(build.body).toContain('Priority in Harness: high.');
    expect(build.body).toContain('"area": "core"');

    const ship = byExternal(alpha, A2);
    expect(ship.status).toBe('open');
    expect(ship.prUrl).toBe('https://github.com/example/alpha/pull/7');
    expect(ship.body).toContain(
      'In flight in Harness (in_review) when it was imported; no agent was carried over.',
    );
    expect(ship.dependsOn).toEqual([build.id]);

    const gauge = byExternal(beta, B1);
    expect(gauge.status).toBe('blocked');
    expect(gauge.dependsOn).toEqual([ship.id]);

    const dial = byExternal(beta, B2);
    expect(dial.status).toBe('proposed');
    expect(dial.dependsOn).toEqual([]);
    expect(dial.body).toContain(
      `Parent ticket: ${gauge.id} ("Wire the gauge").`,
    );

    expect(await notesIn(box.home, 'alpha')).toEqual([
      {
        externalId: N1,
        body: 'Run the widget tests before pushing.',
        pinned: true,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        externalId: N2,
        body: 'Keep pull requests small.',
        pinned: false,
        createdAt: new Date('2026-08-02T00:00:00Z'),
      },
    ]);
    expect(
      (await notesIn(box.home, 'beta')).map((note) => note.externalId),
    ).toEqual([N2]);

    const kinds = await withStore(box.home, 'alpha', async (store) => {
      const { rows } = await store.db.query<{ kind: string }>(
        'select kind from events where project_id = $1 order by id',
        [store.projectId],
      );
      return rows.map((row) => row.kind);
    });
    expect(kinds).toContain(TICKETS_IMPORTED_EVENT);
    expect(kinds).toContain(NOTEBOOK_IMPORTED_EVENT);

    const rules = JSON.parse(
      await readFile(
        join(quarterdeckHome(box.home), 'rules.local.lifecycle.json'),
        'utf8',
      ),
    ) as unknown;
    expect(rules).toEqual({
      mergeGate: { requireAiReview: true, autoMerge: false },
    });
  });

  it('changes nothing on a second run', async () => {
    expect(await run(['--apply'], harnessIo(box, harness))).toBe(0);
    const before = {
      alpha: await ticketsIn(box.home, 'alpha'),
      beta: await ticketsIn(box.home, 'beta'),
      alphaNotes: await notesIn(box.home, 'alpha'),
      events: await eventCount(box.home, 'alpha'),
    };

    const io = harnessIo(box, harness);
    expect(await run(['--apply'], io)).toBe(0);

    expect(output(io)).toContain('Project alpha (existing)');
    expect(output(io)).toContain(
      '  tickets: 0 to create, 0 to update, 2 unchanged, 0 left as they are',
    );
    expect(output(io)).toContain('already set.');
    expect(io.lines.at(-1)).toBe(
      'Nothing to change: everything is already imported.',
    );
    expect(await listProjects(box.home)).toEqual(['alpha', 'beta']);
    expect(await ticketsIn(box.home, 'alpha')).toEqual(before.alpha);
    expect(await ticketsIn(box.home, 'beta')).toEqual(before.beta);
    expect(await notesIn(box.home, 'alpha')).toEqual(before.alphaNotes);
    expect(await eventCount(box.home, 'alpha')).toBe(before.events);
  });

  it('updates what it imported before, matched on the Harness id', async () => {
    expect(await run(['--apply'], harnessIo(box, harness))).toBe(0);
    const [first] = (await ticketsIn(box.home, 'alpha')).filter(
      (row) => row.externalId === A1,
    );
    await harness.db.query(
      `update docket_items set title = 'Build the better widget' where id = $1`,
      [A1],
    );
    await harness.db.query(
      'update harness_notebook set pinned = true where id = $1',
      [N2],
    );

    const io = harnessIo(box, harness);
    expect(await run(['--apply'], io)).toBe(0);

    expect(io.lines.at(-1)).toBe(
      'Imported: 0 projects created, 0 tickets created and 1 updated, 0 notebook entries created and 2 updated.',
    );
    const alpha = await ticketsIn(box.home, 'alpha');
    expect(alpha).toHaveLength(2);
    expect(byExternal(alpha, A1)).toMatchObject({
      id: first?.id,
      title: 'Build the better widget',
    });
    expect(
      (await notesIn(box.home, 'beta')).map((note) => note.pinned),
    ).toEqual([true]);
  });

  it('leaves a ticket Quarterdeck has picked up as it is', async () => {
    expect(await run(['--apply'], harnessIo(box, harness))).toBe(0);
    await withStore(box.home, 'alpha', (store) =>
      store.db.query(
        `update tickets set status = 'in_progress' where external_id = $1`,
        [A1],
      ),
    );
    await harness.db.query(
      `update docket_items set title = 'Renamed in Harness' where id = $1`,
      [A1],
    );

    const io = harnessIo(box, harness);
    expect(await run(['--apply'], io)).toBe(0);

    expect(output(io)).toContain('left as it is: in_progress in Quarterdeck');
    expect(io.lines.at(-1)).toBe(
      'Nothing to change: everything is already imported.',
    );
    const build = byExternal(await ticketsIn(box.home, 'alpha'), A1);
    expect(build.title).toBe('Build the widget');
  });

  it('matches a project already in Quarterdeck by name instead of creating it', async () => {
    const init = testIo(box.home);
    expect(
      await main(
        ['init', box.repo, '--project', 'alpha', '--name', 'alpha'],
        init,
      ),
    ).toBe(0);

    const io = harnessIo(box, harness);
    expect(await run(['--apply'], io)).toBe(0);

    expect(output(io)).toContain(
      'Project alpha (existing), from Harness project "alpha"\n  matches the existing project by name',
    );
    expect(await listProjects(box.home)).toEqual(['alpha', 'beta']);
    expect((await projectRow(box.home, 'alpha'))?.repoPath).toBe(box.repo);
    expect(await ticketsIn(box.home, 'alpha')).toHaveLength(2);
  });

  it('imports archived projects with --include-archived', async () => {
    const io = harnessIo(box, harness);
    expect(await run(['--include-archived'], io)).toBe(0);
    expect(output(io)).toContain('Project gamma (new)');
    expect(output(io)).toContain(
      `repository ${join(box.home, 'repos', 'gamma')} is not a folder on this machine; created without one`,
    );
  });

  it('refuses to run during an open voyage, before reading Harness', async () => {
    expect(await run(['--apply'], harnessIo(box, harness))).toBe(0);
    await withStore(box.home, 'beta', (store) =>
      store.db.query(
        `insert into voyages (project_id, number, status, goal)
         values ($1, 4, 'active', 'ship')`,
        [store.projectId],
      ),
    );
    harness.urls.length = 0;

    const io = harnessIo(box, harness);
    expect(await run(['--apply'], io)).toBe(1);

    expect(io.errors).toEqual([
      'Voyage 4 is active in beta; end it before importing. Nothing was read or written.',
    ]);
    expect(harness.urls).toEqual([]);
  });

  it('reads Harness in one read-only transaction and never writes to it', async () => {
    const before = await harnessCounts(harness.db);

    expect(await run(['--apply'], harnessIo(box, harness))).toBe(0);

    expect(harness.statements[0]).toBe(
      'set default_transaction_read_only = on',
    );
    expect(harness.statements).toContain(
      'begin transaction isolation level repeatable read read only',
    );
    expect(harness.statements.at(-1)).toBe('commit');
    for (const sql of harness.statements)
      expect(sql).toMatch(/^(set|select|begin|commit)\b/);
    expect(await harnessCounts(harness.db)).toBe(before);
  });

  it('leaves the session read-only, so a write through it fails', async () => {
    const session: HarnessSession = {
      query: async <T>(sql: string, params?: unknown[]) =>
        harness.db.query<T>(sql, params),
      close: () => Promise.resolve(),
    };

    const snapshot = await readHarness(session);

    expect(snapshot.projects.map((project) => project.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    await expect(
      session.query(`delete from docket_items where id = '${A1}'`),
    ).rejects.toThrow(/read-only transaction/);
    await expect(
      session.query('create table harness_scratch (id int)'),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('never prints the connection string, even when the connection fails', async () => {
    const io = harnessIo(box, harness);
    expect(await run(['--database-url', URL_WITH_SECRET], io)).toBe(0);
    expect(harness.urls).toEqual([URL_WITH_SECRET]);
    expect(output(io)).not.toContain(PASSWORD);
    expect(output(io)).not.toContain('db.example.test');

    const failing = harnessIo(box, harness);
    failing.harness = (url) =>
      Promise.reject(
        new PostgresSessionError(
          new Error(`password authentication failed for ${url} (${PASSWORD})`),
        ),
      );
    expect(await run([], failing)).toBe(1);
    expect(failing.errors).toEqual([
      'Could not read Harness, so nothing was imported: could not connect to its database: password authentication failed for [redacted] ([redacted])',
    ]);
  });

  it('needs a connection string', async () => {
    const io = testIo(box.home);
    io.env = {};
    expect(await run([], io)).toBe(1);
    expect(io.errors).toEqual([
      `import harness needs Harness's connection string: pass --database-url or set ${HARNESS_DATABASE_URL}`,
    ]);
  });

  it('prints its usage and refuses an unknown source', async () => {
    const help = testIo(box.home);
    expect(await main(['import', 'harness', '--help'], help)).toBe(0);
    expect(help.lines).toEqual([IMPORT_USAGE]);

    const unknown = testIo(box.home);
    expect(await main(['import', 'elsewhere'], unknown)).toBe(1);
    expect(unknown.errors[0]).toContain('Unknown import source elsewhere');
  });
});

describe.skipIf(POSTGRES_URL === '')(
  'quarterdeck import harness on Postgres',
  { timeout: TIMEOUT },
  () => {
    let url: string;

    beforeEach(async () => {
      url = await createDatabase(POSTGRES_URL);
      const seed = await connectPostgresSession(url, 'seed');
      try {
        await seed.query(HARNESS_SCHEMA);
        await seed.query(HARNESS_ROWS);
      } finally {
        await seed.close();
      }
    });

    afterEach(async () => {
      await dropDatabase(url, POSTGRES_URL);
    });

    it('reads through a read-only session that refuses writes', async () => {
      const session = await connectPostgresSession(url, 'quarterdeck-import');
      try {
        const snapshot = await readHarness(session);
        expect(snapshot.items.map((item) => item.id)).toEqual([
          A1,
          A2,
          B1,
          B2,
          G1,
        ]);
        expect(snapshot.notes.map((note) => note.id)).toEqual([N1, N2]);
        await expect(
          session.query(`update docket_items set title = 'x'`),
        ).rejects.toThrow(/read-only transaction/);
      } finally {
        await session.close();
      }
    });
  },
);
