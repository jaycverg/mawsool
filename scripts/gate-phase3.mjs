// @ts-check
// `pnpm gate:phase3`: Phase 3's browser acceptance (consent, ticket, revoke, delete everything). See e2e-gate.mjs.
import { runGate } from './e2e-gate.mjs';

await runGate({ name: 'gate:phase3', spec: 'phase3-acceptance.spec.ts', registry: 'acceptance-phase3.json', portShift: 300 });
