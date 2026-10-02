import { createClientAdapter } from './client-adapter.ts';
import { describeClientConformance } from './runtime-conformance.ts';

describeClientConformance(createClientAdapter());
