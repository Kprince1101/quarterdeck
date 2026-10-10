import type { SetupTool } from '../intents/index.js';

export interface SetupProbe {
  tools: (repoPaths: readonly string[]) => Promise<SetupTool[]>;
}
