import type { RuntimeAdapter } from '../runtimes/adapter.js';
import { runtimeSignInDriver } from './runtimes.js';

export const withRuntimeSignIn = (adapter: RuntimeAdapter): RuntimeAdapter => ({
  ...adapter,
  connect: async (launch, options) => {
    const client = await adapter.connect(launch, options);
    const base = launch.command && { command: launch.command };
    return {
      ...client,
      signIn: runtimeSignInDriver(adapter.runtime, base || {}),
    };
  },
});
