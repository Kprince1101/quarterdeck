import { describe, expect, it } from 'vitest';
import { DOCTOR_FIXES, type DoctorCheck } from '../src/doctor.js';
import { setupToolsOf } from '../src/setup-probe.js';

const checks: DoctorCheck[] = [
  {
    name: 'kiro-cli',
    state: 'not installed',
    fixes: [
      { label: 'Install', command: DOCTOR_FIXES.kiroInstall },
      { label: 'Sign in', command: DOCTOR_FIXES.kiroSignIn },
    ],
  },
  {
    name: 'claude',
    state: '2.1.0, not signed in',
    fixes: [{ label: 'Sign in', command: DOCTOR_FIXES.claudeSignIn }],
  },
  { name: 'gemini', state: '0.9.0, signed in (Google account)', fixes: [] },
  { name: 'gh', state: '2.80.0, signed in (me on github.com)', fixes: [] },
  {
    name: 'gh for agents',
    state: 'signed in only through GH_TOKEN',
    fixes: [{ label: 'Sign in', command: DOCTOR_FIXES.ghSignIn }],
  },
  {
    name: 'glab',
    state: 'not installed, needed for git.example.org',
    fixes: [{ label: 'Install', command: 'brew install glab' }],
  },
];

describe('setup tools from doctor checks', () => {
  it('turns every runtime check into an entry, installed or not, with the hint doctor prints', () => {
    const runtimes = setupToolsOf(checks, []);
    expect(runtimes).toEqual([
      {
        tool: { kind: 'runtime', runtime: 'kiro' },
        name: 'Kiro',
        state: 'not installed',
        installed: false,
        signedIn: false,
        hint: DOCTOR_FIXES.kiroInstall,
      },
      {
        tool: { kind: 'runtime', runtime: 'claude' },
        name: 'Claude Code',
        state: '2.1.0, not signed in',
        installed: true,
        signedIn: false,
        hint: DOCTOR_FIXES.claudeSignIn,
      },
      {
        tool: { kind: 'runtime', runtime: 'gemini' },
        name: 'Gemini CLI',
        state: '0.9.0, signed in (Google account)',
        installed: true,
        signedIn: true,
        hint: null,
      },
    ]);
  });

  it('keeps only the forge CLIs the workspace repositories use', () => {
    const forges = setupToolsOf(checks, [
      { kind: 'gh' },
      { kind: 'glab', host: 'git.example.org' },
    ]).filter(({ tool }) => tool.kind !== 'runtime');
    expect(forges).toEqual([
      {
        tool: { kind: 'gh' },
        name: 'GitHub (gh)',
        state: '2.80.0, signed in (me on github.com)',
        installed: true,
        signedIn: true,
        hint: null,
      },
      {
        tool: { kind: 'glab', host: 'git.example.org' },
        name: 'GitLab on git.example.org (glab)',
        state: 'not installed, needed for git.example.org',
        installed: false,
        signedIn: false,
        hint: 'brew install glab',
      },
    ]);
  });
});
