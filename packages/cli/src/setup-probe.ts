import {
  signInToolName,
  type SetupProbe,
  type SignInTool,
} from '@quarterdeck/server';
import type { SetupTool } from '@quarterdeck/server/intents';
import { withClaudeAuthEnv } from './doctor-claude-auth.js';
import { runDoctorChecks, type DoctorCheck } from './doctor.js';
import type { CliIo } from './io.js';
import {
  forgeCheckFolder,
  repoForges,
  sameTool,
  uniqueForges,
} from './project-forges.js';
import { signInToolOfName } from './signin.js';

const MISSING_LABELS: ReadonlySet<string> = new Set(['Install', 'Download']);
const SIGN_IN_LABEL = 'Sign in';
const GLAB_CHECK = 'glab';

const isInstalled = (check: DoctorCheck): boolean =>
  !check.fixes.some((fix) => MISSING_LABELS.has(fix.label));

const isSignedOut = (check: DoctorCheck): boolean =>
  check.fixes.some((fix) => fix.label === SIGN_IN_LABEL);

const hintOf = (check: DoctorCheck): string | null => {
  const missing = check.fixes.find((fix) => MISSING_LABELS.has(fix.label));
  if (missing !== undefined) return missing.command;
  return (
    check.fixes.find(({ label }) => label === SIGN_IN_LABEL)?.command ?? null
  );
};

const toSetupTool = (check: DoctorCheck, tool: SignInTool): SetupTool => {
  const installed = isInstalled(check);
  return {
    tool,
    name: signInToolName(tool),
    state: check.state,
    installed,
    signedIn: installed && !isSignedOut(check),
    hint: hintOf(check),
  };
};

const toolsOfCheck = (
  check: DoctorCheck,
  forges: readonly SignInTool[],
): SignInTool[] => {
  if (check.name === GLAB_CHECK) {
    return forges.filter((forge) => forge.kind === 'glab');
  }
  const tool = signInToolOfName(check.name);
  if (tool === undefined) return [];
  if (tool.kind === 'runtime') return [tool];
  return forges.filter((forge) => sameTool(forge, tool));
};

export const setupToolsOf = (
  checks: readonly DoctorCheck[],
  forges: readonly SignInTool[],
): SetupTool[] =>
  checks.flatMap((check) =>
    toolsOfCheck(check, forges).map((tool) => toSetupTool(check, tool)),
  );

export const createSetupProbe = (io: CliIo): SetupProbe => ({
  tools: async (repoPaths) => {
    const forges = await repoForges(io, repoPaths);
    const cwd = forgeCheckFolder(repoPaths, forges) ?? io.homeDir;
    const checks = await runDoctorChecks(
      await withClaudeAuthEnv({ ...io, cwd }),
    );
    return setupToolsOf(checks, uniqueForges(forges));
  },
});
