// @ts-check
// `pnpm gate:phase2`: Phase 2's exit acceptance (the person flow). See e2e-gate.mjs.
import { runGate } from './e2e-gate.mjs';

await runGate({ name: 'gate:phase2', spec: 'exit-acceptance.spec.ts', registry: 'acceptance.json', portShift: 250 });
