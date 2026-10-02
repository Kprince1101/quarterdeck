import type { RuleName } from '@quarterdeck/rules';
import type { IntentResult } from '../../intents/index.js';
import type { ApiContext, IntentHandler, IntentHandlers } from '../context.js';
import { applyInProject, unrecorded } from '../record.js';
import { requireRepoPath } from '../repo-path.js';
import {
  removeRuleLayer,
  writeRuleLayer,
  type RuleLayerTarget,
} from '../rule-files.js';

type RulesIntentName = 'rules.write' | 'rules.reset';

type LayerChange = (target: RuleLayerTarget) => Promise<IntentResult>;

type RulesInput =
  | { scope: 'machine'; name: RuleName }
  | { scope: 'project'; project: string; name: RuleName };

const changeLayer = (
  ctx: ApiContext,
  intent: RulesIntentName,
  input: RulesInput,
  change: LayerChange,
) => {
  const target = { name: input.name, homeDir: ctx.homeDir };
  if (input.scope === 'machine') {
    return change(target).then((result) => unrecorded(intent, result));
  }
  return applyInProject(ctx, intent, input, async (tx, projectId) =>
    change({ ...target, repoDir: await requireRepoPath(tx, projectId) }),
  );
};

const writeRules: IntentHandler<'rules.write'> = (ctx, input, intent) =>
  changeLayer(ctx, intent, input, async (target) => ({
    path: await writeRuleLayer(target, input.content),
  }));

const resetRules: IntentHandler<'rules.reset'> = (ctx, input, intent) =>
  changeLayer(ctx, intent, input, async (target) => ({
    ...(await removeRuleLayer(target)),
  }));

export const RULES_HANDLERS: IntentHandlers<RulesIntentName> = {
  'rules.write': writeRules,
  'rules.reset': resetRules,
};
