import type { RuleName } from '@quarterdeck/rules';
import type {
  ApiContext,
  IntentHandler,
  IntentHandlers,
  StagedWork,
} from '../context.js';
import { applyStagedInProject, unrecorded } from '../record.js';
import { requireRepoPath } from '../repo-path.js';
import {
  stageRuleRemoval,
  stageRuleWrite,
  type RuleLayerTarget,
} from '../rule-files.js';

type RulesIntentName = 'rules.write' | 'rules.reset';

type LayerChange = (target: RuleLayerTarget) => Promise<StagedWork>;

type RulesInput =
  | { scope: 'machine'; name: RuleName }
  | { scope: 'project'; project: string; name: RuleName };

const changeMachineLayer = async (
  intent: RulesIntentName,
  target: RuleLayerTarget,
  change: LayerChange,
) => {
  const staged = await change(target);
  await staged.afterCommit();
  return unrecorded(intent, staged.result);
};

const changeLayer = (
  ctx: ApiContext,
  intent: RulesIntentName,
  input: RulesInput,
  change: LayerChange,
) => {
  const target = { name: input.name, homeDir: ctx.homeDir };
  if (input.scope === 'machine') {
    return changeMachineLayer(intent, target, change);
  }
  return applyStagedInProject(ctx, intent, input, async (tx, projectId) =>
    change({ ...target, repoDir: await requireRepoPath(tx, projectId) }),
  );
};

const writeRules: IntentHandler<'rules.write'> = (ctx, input, intent) =>
  changeLayer(ctx, intent, input, (target) =>
    stageRuleWrite(target, input.content),
  );

const resetRules: IntentHandler<'rules.reset'> = (ctx, input, intent) =>
  changeLayer(ctx, intent, input, stageRuleRemoval);

export const RULES_HANDLERS: IntentHandlers<RulesIntentName> = {
  'rules.write': writeRules,
  'rules.reset': resetRules,
};
