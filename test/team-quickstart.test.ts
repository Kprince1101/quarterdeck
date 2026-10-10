import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const QUICKSTART_PATH = resolve(ROOT, 'docs/team-quickstart.md');
const QUICKSTART = readFileSync(QUICKSTART_PATH, 'utf8');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const RELEASE_NOTES = readFileSync(
  resolve(ROOT, 'docs/release-notes/v4.0.0.md'),
  'utf8',
);

const section = (text: string, heading: string): string => {
  const [, after = ''] = text.split(`\n${heading}\n`);
  const level = heading.split(' ')[0] ?? '##';
  const [body = ''] = after.split(`\n${level} `);
  return body;
};

const TRACKS = ['## Track A: Claude Code', '## Track B: Kiro on GitLab'];
const STEPS = ['### 1. Install', '### 2. Up', '### 3. The Setup screen'];

describe('docs/team-quickstart.md', () => {
  it.each(TRACKS)('%s has install, up, Setup and a first voyage', (track) => {
    const body = section(QUICKSTART, track);
    STEPS.forEach((step) => expect(body).toContain(step));
    expect(body).toContain('[A first voyage](#a-first-voyage)');
  });

  it('gives the Vertex env the Claude track needs', () => {
    const body = section(QUICKSTART, TRACKS[0] ?? '');
    for (const name of [
      'QUARTERDECK_CLAUDE_AUTH=vertex',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'CLOUD_ML_REGION',
      'gcloud auth application-default login',
    ])
      expect(body).toContain(name);
  });

  it('gives the Kiro track kiro-cli, glab and the one-line forge mapping', () => {
    const body = section(QUICKSTART, TRACKS[1] ?? '');
    expect(body).toContain('kiro-cli');
    expect(body).toContain('glab');
    expect(body).toContain(
      `'{ "forges": { "gitlab.example.com": "gitlab" } }' > ~/.quarterdeck/rules.local.forges.json`,
    );
  });

  it('says where data lives and how to delete it', () => {
    const body = section(QUICKSTART, '## Your data and security');
    expect(body).toContain('holds no API keys');
    expect(body).toContain('new on every start');
    expect(body).toContain('[redacted]');
    expect(body).toContain('delete that folder');
  });

  it('mentions keep-awake for a voyage left to run', () => {
    expect(section(QUICKSTART, '## A first voyage')).toContain(
      '**Keep awake**',
    );
  });

  it('starts the trouble list with doctor', () => {
    const body = section(QUICKSTART, '## If something is wrong');
    expect(body).toMatch(/^\s*1\. \*\*Run `npm run quarterdeck -- doctor`\*\*/);
  });

  it('links only to files that exist', () => {
    const links = [...QUICKSTART.matchAll(/\]\(([^)#:]+)(?:#[^)]*)?\)/g)];
    links.forEach(([, path = '']) =>
      expect(existsSync(resolve(dirname(QUICKSTART_PATH), path))).toBe(true),
    );
  });
});

describe('docs/release-notes/v4.0.0.md', () => {
  it.each([
    '## Get it running',
    '## What changed since October 3',
    '## Known limits',
    '## Where your data lives, and how to delete it',
  ])('has %s', (heading) => {
    expect(section(RELEASE_NOTES, heading).trim()).not.toBe('');
  });

  it.each([
    '**Setup screen.**',
    '**Sign in through the runtime itself.**',
    '**Workspaces and single-repo mode.**',
    '**Claude on Vertex AI.**',
    '**Rules profiles.**',
    '**Keep-awake.**',
    '**Images in the Planner and in card answers.**',
    '**The chat input is a regular chatbox.**',
  ])('lists %s among the changes', (feature) => {
    expect(section(RELEASE_NOTES, '## What changed since October 3')).toContain(
      `- ${feature}`,
    );
  });

  it('names the attachments folder where data lives', () => {
    expect(
      section(RELEASE_NOTES, '## Where your data lives, and how to delete it'),
    ).toContain('~/.quarterdeck/<project>/attachments/');
  });

  it('points at the quickstart', () => {
    expect(RELEASE_NOTES).toContain('docs/team-quickstart.md');
  });
});

describe('README points newcomers at the quickstart', () => {
  it.each(['Running it', 'Getting started from a terminal'])(
    '%s links to docs/team-quickstart.md',
    (heading) => {
      expect(section(README, `## ${heading}`)).toContain(
        '(docs/team-quickstart.md',
      );
    },
  );
});
