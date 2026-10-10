import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadRule, ruleLayerPaths } from '@quarterdeck/rules';
import {
  PostgresSessionError,
  QUARTERDECK_COMMAND,
  TICKETS_IMPORTED_EVENT,
  connectPostgresSession,
  createProjectStores,
  createWorkspaces,
  dispatchIntent,
  ensurePrivateDir,
  publishEvent,
  quarterdeckHome,
  type ProjectStores,
  type Queryable,
  type Store,
} from '@quarterdeck/server';
import {
  HARNESS_SOURCE,
  noteKey,
  planImport,
  type ExistingGlobalNote,
  type ExistingNote,
  type ExistingProject,
  type ExistingTicket,
  type ImportPlan,
  type NotePlan,
  type ProjectPlan,
  type QuarterdeckState,
  type RowAction,
  type TicketPlan,
} from './harness-plan.js';
import {
  readHarness,
  type HarnessConnector,
  type HarnessSnapshot,
} from './harness-read.js';
import { parseIntent } from './intent.js';
import { CliError, type CliIo, type Command } from './io.js';
import { jsonText, readJsonLayer } from './json-layer.js';
import { repoForges } from './project-forges.js';

export const HARNESS_DATABASE_URL = 'HARNESS_DATABASE_URL';

export const NOTEBOOK_IMPORTED_EVENT = 'notebook.imported';

const APPLICATION_NAME = 'quarterdeck-import';

export const IMPORT_USAGE = `Usage: ${QUARTERDECK_COMMAND} import harness [--apply] [options]

Reads Harness's projects, open docket items and active notebook entries in one
read-only transaction and shows what it would import into Quarterdeck. Nothing
is written unless you pass --apply. Harness itself is never written to.
Running it again updates what it imported before and adds nothing twice.

  --database-url <url>  Harness's Postgres connection string (default: $${HARNESS_DATABASE_URL})
  --dry-run             Show every mapping decision and write nothing (the default)
  --apply               Import: create the projects, tickets and notebook entries
  --include-archived    Import archived Harness projects too`;

const defaultConnector: HarnessConnector = (url) =>
  connectPostgresSession(url, APPLICATION_NAME);

const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const secretsOf = (url: string): string[] => {
  const secrets = [url];
  if (URL.canParse(url)) {
    const { password } = new URL(url);
    secrets.push(password, decoded(password));
  }
  return secrets.filter((secret) => secret !== '');
};

export const redactSecrets = (message: string, url: string): string =>
  secretsOf(url).reduce(
    (redacted, secret) => redacted.replaceAll(secret, '[redacted]'),
    message,
  );

const failureOf = (err: unknown): string => {
  if (err instanceof PostgresSessionError) {
    if (!(err.cause instanceof Error))
      return 'could not connect to its database';
    return `could not connect to its database: ${err.cause.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
};

const readFrom = async (
  url: string,
  connect: HarnessConnector,
): Promise<HarnessSnapshot> => {
  try {
    const session = await connect(url);
    try {
      return await readHarness(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof CliError)
      throw new CliError(redactSecrets(err.message, url));
    throw new CliError(
      `Could not read Harness, so nothing was imported: ${redactSecrets(failureOf(err), url)}`,
    );
  }
};

const openProjects = async (stores: ProjectStores): Promise<Store[]> => {
  const opened: Store[] = [];
  for (const project of await stores.list())
    opened.push(await stores.get(project));
  return opened;
};

const refuseOpenVoyage = async (stores: readonly Store[]): Promise<void> => {
  for (const store of stores) {
    const { rows } = await store.db.query<{
      slug: string;
      number: number;
      status: string;
    }>(
      `select p.slug, v.number, v.status from voyages v
       join projects p on p.id = v.project_id
       where v.project_id = $1 and v.status <> 'ended'
       order by v.number limit 1`,
      [store.projectId],
    );
    const [open] = rows;
    if (open !== undefined)
      throw new CliError(
        `Voyage ${open.number} is ${open.status} in ${open.slug}; end it before importing. Nothing was read or written.`,
      );
  }
};

const projectOf = async (store: Store): Promise<ExistingProject> => {
  const { rows } = await store.db.query<ExistingProject>(
    `select slug, name, repo_path as "repoPath" from projects where id = $1`,
    [store.projectId],
  );
  const [row] = rows;
  if (!row) throw new CliError('A Quarterdeck project has no projects row.');
  return row;
};

const ticketsOf = async (
  store: Store,
  slug: string,
): Promise<[string, ExistingTicket][]> => {
  const { rows } = await store.db.query<
    Omit<ExistingTicket, 'project'> & { externalId: string }
  >(
    `select id, external_id as "externalId", title, body, status,
       depends_on as "dependsOn", pr_url as "prUrl"
     from tickets where project_id = $1 and source = $2`,
    [store.projectId, HARNESS_SOURCE],
  );
  return rows.map(({ externalId, ...ticket }) => [
    externalId,
    { ...ticket, project: slug },
  ]);
};

interface NoteRow extends ExistingNote {
  externalId: string;
  global: boolean;
}

const notesOf = async (store: Store): Promise<NoteRow[]> => {
  const { rows } = await store.db.query<NoteRow>(
    `select id, external_id as "externalId", body, pinned,
       retired_at is not null as retired, project_id is null as global
     from notebook
     where (project_id = $1 or project_id is null) and external_id is not null`,
    [store.projectId],
  );
  return rows;
};

const lifecyclePath = (homeDir: string): string => {
  const [machine] = ruleLayerPaths('lifecycle', { homeDir }).local;
  if (machine === undefined) throw new Error('lifecycle has no machine layer');
  return machine;
};

const quarterdeckState = async (
  stores: readonly Store[],
  homeDir: string,
): Promise<QuarterdeckState> => {
  const projects: ExistingProject[] = [];
  const tickets = new Map<string, ExistingTicket>();
  const notes = new Map<string, ExistingNote>();
  const globalNotes = new Map<string, ExistingGlobalNote>();
  for (const store of stores) {
    const project = await projectOf(store);
    projects.push(project);
    for (const [id, ticket] of await ticketsOf(store, project.slug))
      tickets.set(id, ticket);
    for (const { externalId, global, ...note } of await notesOf(store)) {
      if (!global) notes.set(noteKey(project.slug, externalId), note);
      else if (!globalNotes.has(externalId))
        globalNotes.set(externalId, { ...note, project: project.slug });
    }
  }
  const path = lifecyclePath(homeDir);
  return {
    projects,
    tickets,
    notes,
    globalNotes,
    lifecyclePath: path,
    lifecycleLayer: await readJsonLayer(path),
  };
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const projectKind = (plan: ProjectPlan): string => {
  if (plan.created) return 'new';
  return 'existing';
};

const rulesState = (change: boolean): string => {
  if (change) return 'to write';
  return 'already set';
};

const rulesWritten = (plan: ImportPlan): string => {
  if (plan.rules?.change) return '; rules written';
  return '';
};

const ACTION_WORDS: Record<RowAction, string> = {
  create: 'to create',
  update: 'to update',
  unchanged: 'unchanged',
  kept: 'left as they are',
};

const counted = (rows: readonly { action: RowAction }[]): string =>
  (Object.keys(ACTION_WORDS) as RowAction[])
    .map(
      (action) =>
        `${rows.filter((row) => row.action === action).length} ${ACTION_WORDS[action]}`,
    )
    .join(', ');

const rowLine = (
  label: string,
  row: { action: RowAction; decisions: string[] },
): string => `    ${[`${label}: ${row.action}`, ...row.decisions].join('; ')}`;

const projectLines = (plan: ProjectPlan): string[] => {
  return [
    `Project ${plan.slug} (${projectKind(plan)}), from Harness project ${JSON.stringify(plan.harness.name)}`,
    ...plan.decisions.map((decision) => `  ${decision}`),
    `  tickets: ${counted(plan.tickets)}`,
    ...plan.tickets.map((ticket) =>
      rowLine(
        `ticket ${ticket.harnessId} ${JSON.stringify(ticket.title)}`,
        ticket,
      ),
    ),
    `  notebook entries: ${counted(plan.notes)}`,
    ...plan.notes.map((note) =>
      rowLine(`notebook entry ${note.harnessId}`, note),
    ),
  ];
};

const globalNoteLines = (plan: ImportPlan): string[] => {
  if (plan.globalNotes.length === 0) return [];
  return [
    `Global notebook (Harness global entries, each imported once as an entry for every project): ${counted(plan.globalNotes)}`,
    ...plan.globalNotes.map((note) =>
      rowLine(`notebook entry ${note.harnessId}`, {
        ...note,
        decisions: [`stored with ${note.project}`, ...note.decisions],
      }),
    ),
  ];
};

const plural = (count: number, one: string, many: string): string => {
  if (count === 1) return `1 ${one}`;
  return `${count} ${many}`;
};

const rulesLine = (plan: ImportPlan): string[] => {
  const { rules } = plan;
  if (rules === null) return [];
  const state = rulesState(rules.change);
  return [`Rules in ${rules.path}: ${rules.decisions.join('; ')}; ${state}.`];
};

const printPlan = (
  io: CliIo,
  snapshot: HarnessSnapshot,
  plan: ImportPlan,
): void => {
  io.out(
    `Read from Harness: ${plural(snapshot.projects.length, 'project', 'projects')}, ${plural(snapshot.items.length, 'open docket item', 'open docket items')}, ${plural(snapshot.notes.length, 'active notebook entry', 'active notebook entries')}.`,
  );
  for (const project of plan.projects) io.out(projectLines(project).join('\n'));
  const globals = globalNoteLines(plan);
  if (globals.length > 0) io.out(globals.join('\n'));
  for (const line of [...plan.skipped, ...plan.reviewers, ...rulesLine(plan)])
    io.out(line);
};

const allTickets = (plan: ImportPlan): TicketPlan[] =>
  plan.projects.flatMap((project) => project.tickets);

const allNotes = (plan: ImportPlan): NotePlan[] => [
  ...plan.projects.flatMap((project) => project.notes),
  ...plan.globalNotes,
];

const notebookProjectId = (
  projectId: string,
  note: NotePlan,
): string | null => {
  if (note.global) return null;
  return projectId;
};

const writes = (row: { action: RowAction }): boolean =>
  row.action === 'create' || row.action === 'update';

const changesSomething = (plan: ImportPlan): boolean =>
  plan.projects.some((project) => project.created) ||
  allTickets(plan).some(writes) ||
  allNotes(plan).some(writes) ||
  plan.rules?.change === true;

const writeTicket = async (
  tx: Queryable,
  projectId: string,
  ticket: TicketPlan,
): Promise<void> => {
  if (ticket.action === 'create') {
    await tx.query(
      `insert into tickets
         (id, project_id, title, body, status, depends_on, source, external_id, pr_url)
       values ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9)`,
      [
        ticket.id,
        projectId,
        ticket.title,
        ticket.body,
        ticket.status,
        ticket.dependsOn,
        HARNESS_SOURCE,
        ticket.harnessId,
        ticket.prUrl,
      ],
    );
    return;
  }
  await tx.query(
    `update tickets set title = $3, body = $4, status = $5,
       depends_on = $6::uuid[], pr_url = $7
     where id = $1 and project_id = $2`,
    [
      ticket.id,
      projectId,
      ticket.title,
      ticket.body,
      ticket.status,
      ticket.dependsOn,
      ticket.prUrl,
    ],
  );
};

const writeNote = async (
  tx: Queryable,
  projectId: string,
  note: NotePlan,
): Promise<void> => {
  if (note.action === 'create') {
    await tx.query(
      `insert into notebook (id, project_id, body, pinned, created_at, external_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        note.id,
        notebookProjectId(projectId, note),
        note.body,
        note.pinned,
        note.createdAt,
        note.harnessId,
      ],
    );
    return;
  }
  await tx.query(
    `update notebook set body = $3, pinned = $4
     where id = $1 and project_id is not distinct from $2::uuid`,
    [note.id, notebookProjectId(projectId, note), note.body, note.pinned],
  );
};

const idsOf = (rows: readonly { id: string; action: RowAction }[]) => ({
  created: rows.filter((row) => row.action === 'create').map((row) => row.id),
  updated: rows.filter((row) => row.action === 'update').map((row) => row.id),
});

const writeRows = (
  store: Store,
  tickets: readonly TicketPlan[],
  notes: readonly NotePlan[],
): Promise<void> =>
  store.db.transaction(async (tx) => {
    for (const ticket of tickets)
      await writeTicket(tx, store.projectId, ticket);
    for (const note of notes) await writeNote(tx, store.projectId, note);
    if (tickets.length > 0)
      await publishEvent(tx, store.projectId, {
        kind: TICKETS_IMPORTED_EVENT,
        payload: { source: HARNESS_SOURCE, ...idsOf(tickets) },
      });
    if (notes.length > 0)
      await publishEvent(tx, store.projectId, {
        kind: NOTEBOOK_IMPORTED_EVENT,
        payload: { source: HARNESS_SOURCE, ...idsOf(notes) },
      });
  });

const byProject = <T extends { project: string }>(
  rows: readonly T[],
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const row of rows)
    grouped.set(row.project, [...(grouped.get(row.project) ?? []), row]);
  return grouped;
};

const applyPlan = async (
  stores: ProjectStores,
  io: CliIo,
  plan: ImportPlan,
): Promise<void> => {
  const home = quarterdeckHome(io.homeDir);
  const ctx = {
    stores,
    homeDir: io.homeDir,
    workspaces: createWorkspaces(home),
  };
  await ensurePrivateDir(home);
  if (plan.rules?.change) {
    const content = jsonText(plan.rules.layer);
    await dispatchIntent(
      ctx,
      'rules.write',
      parseIntent('rules.write', {
        scope: 'machine',
        name: 'lifecycle',
        content,
      }),
    );
  }
  for (const project of plan.projects.filter(
    (candidate) => candidate.created,
  )) {
    const repoPath = project.repoPath ?? undefined;
    await dispatchIntent(
      ctx,
      'project.create',
      parseIntent('project.create', {
        project: project.slug,
        name: project.harness.name,
        ...(repoPath !== undefined && { repoPath }),
      }),
    );
    if (project.harness.paused)
      await dispatchIntent(
        ctx,
        'pause.set',
        parseIntent('pause.set', { project: project.slug, paused: true }),
      );
  }
  const tickets = byProject(allTickets(plan).filter(writes));
  const notes = byProject(allNotes(plan).filter(writes));
  for (const slug of new Set([...tickets.keys(), ...notes.keys()])) {
    const store = await stores.get(slug);
    await writeRows(store, tickets.get(slug) ?? [], notes.get(slug) ?? []);
  }
};

const summary = (plan: ImportPlan): string => {
  const tickets = allTickets(plan);
  const notes = allNotes(plan);
  const count = (rows: readonly { action: RowAction }[], action: RowAction) =>
    rows.filter((row) => row.action === action).length;
  const created = plan.projects.filter((project) => project.created).length;
  const rules = rulesWritten(plan);
  return `Imported: ${plural(created, 'project', 'projects')} created, ${count(tickets, 'create')} tickets created and ${count(tickets, 'update')} updated, ${count(notes, 'create')} notebook entries created and ${count(notes, 'update')} updated${rules}.`;
};

interface ProjectRepo {
  slug: string;
  repoPath: string;
}

const projectRepos = (
  state: QuarterdeckState,
  plan: ImportPlan,
): ProjectRepo[] =>
  [
    ...state.projects,
    ...plan.projects.filter((project) => project.created),
  ].flatMap(({ slug, repoPath }) => {
    if (repoPath === null) return [];
    return [{ slug, repoPath }];
  });

const gitlabReviewers = async (homeDir: string): Promise<readonly string[]> => {
  try {
    return (await loadRule('lifecycle', { homeDir })).mergeGate.aiReviewers
      .gitlab;
  } catch {
    return [];
  }
};

const gitlabWarning = async (
  io: CliIo,
  state: QuarterdeckState,
  plan: ImportPlan,
): Promise<string[]> => {
  if (plan.rules?.requireAiReview !== true) return [];
  if ((await gitlabReviewers(io.homeDir)).length > 0) return [];
  const repos = projectRepos(state, plan);
  const forges = await repoForges(
    io,
    repos.map((repo) => repo.repoPath),
  );
  const gitlab = repos
    .filter((_repo, index) => forges[index]?.kind === 'glab')
    .map((repo) => repo.slug);
  if (gitlab.length === 0) return [];
  return [
    `Warning: mergeGate.requireAiReview turns on for every project on this machine, and mergeGate.aiReviewers.gitlab lists no bot logins. The merge gate refuses to run for these GitLab projects until you list the AI reviewer's bot logins there in ${plan.rules.path}: ${gitlab.join(', ')}.`,
  ];
};

const importHarness = async (args: string[], io: CliIo): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'database-url': { type: 'string' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      'include-archived': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.out(IMPORT_USAGE);
    return 0;
  }
  if (positionals.length > 0)
    throw new CliError('import harness takes no arguments');
  if (values['dry-run'] && values.apply)
    throw new CliError('Pass --dry-run or --apply, not both');
  const url = values['database-url'] ?? io.env[HARNESS_DATABASE_URL] ?? '';
  if (url === '')
    throw new CliError(
      `import harness needs Harness's connection string: pass --database-url or set ${HARNESS_DATABASE_URL}`,
    );
  const stores = createProjectStores(quarterdeckHome(io.homeDir));
  try {
    const opened = await openProjects(stores);
    await refuseOpenVoyage(opened);
    const snapshot = await readFrom(url, io.harness ?? defaultConnector);
    const state = await quarterdeckState(opened, io.homeDir);
    const plan = await planImport(snapshot, state, {
      homeDir: io.homeDir,
      includeArchived: values['include-archived'] ?? false,
      isDirectory,
    });
    printPlan(io, snapshot, plan);
    for (const line of await gitlabWarning(io, state, plan)) io.out(line);
    if (!values.apply) {
      io.out('Dry run: nothing written. Run again with --apply to import.');
      return 0;
    }
    if (!changesSomething(plan)) {
      io.out('Nothing to change: everything is already imported.');
      return 0;
    }
    await applyPlan(stores, io, plan);
    io.out(summary(plan));
    return 0;
  } finally {
    await stores.closeAll();
  }
};

export const runImport: Command = async (args, io) => {
  const [source, ...rest] = args;
  if (source === undefined)
    throw new CliError(`import needs a source\n\n${IMPORT_USAGE}`);
  if (source === '--help' || source === '-h') {
    io.out(IMPORT_USAGE);
    return 0;
  }
  if (source !== 'harness')
    throw new CliError(`Unknown import source ${source}\n\n${IMPORT_USAGE}`);
  return importHarness(rest, io);
};
