// @ts-check
// `pnpm gate:phase4`: Phase 4's browser and API acceptance (the receiving side: queue, detail, export, signed inbound
// invites, claim). It drives the real person and clinician apps against the real API. See e2e-gate.mjs.
import { runGate } from './e2e-gate.mjs';

await runGate({ name: 'gate:phase4', spec: 'phase4-acceptance.spec.ts', registry: 'acceptance-phase4.json', portShift: 375, clinician: true, ops: true });
