// @ts-check
// `pnpm gate:c`: Gate C, the spec's finish line: the demo, end to end, in Arabic and English, with no console error
// excused (bar the two 404s that the reset-recovery test names by exact URL and status).
//
// Two halves, both of which must pass:
//   1. the server half (scripts/gate-c.json): every sentence of Phase 5's exit acceptance that a server test can prove is
//      checked against the Vitest runs of the projects it names, as `gate:b` does for Phase 3; and
//   2. the browser half: builds the real person export and the real clinician and ops apps, starts the real API with
//      DEMO_MODE on (the only gate that does) and runs `apps/person/e2e/gate-c.spec.ts`, registry `acceptance-c.json`.
//      The browser fails on any console error and this spec excuses none, except the two 404s the reset-recovery test
//      provokes and names (see PROVOKES_AN_ERROR in the spec).
//
// Ports are the dev ports plus 450 (api 4450, person 3450, clinician 3451, ops 3452), which meet no other gate's. No Docker.
import { runGate } from './e2e-gate.mjs';
import { runServerSide } from './gate-server.mjs';

const serverOk = await runServerSide({
  name: 'gate:c',
  registry: 'scripts/gate-c.json',
  browser: 'acceptance-c.json',
  delegated: { 'gate:phase2': 'acceptance.json', 'gate:phase3': 'acceptance-phase3.json', 'gate:phase4': 'acceptance-phase4.json' },
  timeLimitMs: 9 * 60_000,
});
if (!serverOk) {
  console.log('[gate:c] the server half failed, so the browser half was not run');
  process.exit(1);
}
await runGate({ name: 'gate:c', spec: 'gate-c.spec.ts', registry: 'acceptance-c.json', portShift: 450, clinician: true, ops: true, demo: true, limitMs: 24 * 60_000, suiteTimeoutMs: 20 * 60_000 });
