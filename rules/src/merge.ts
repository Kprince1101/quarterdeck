export { RulesError } from './errors.js';
export { mergeRepoKiro } from './kiro-layer.js';
export { isJsonObject, mergeLayer, type JsonObject } from './merge-layer.js';
export {
  DEPRECATED_AI_REVIEW_KEY,
  mergeRepoLifecycle,
  tightenMergeGate,
  tightenSettleSeconds,
  upgradeLifecycleLayer,
  type UpgradedLayer,
} from './lifecycle-layer.js';
