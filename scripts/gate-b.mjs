// @ts-check
// `pnpm gate:b`: the server side of Phase 3's exit acceptance (the spec's Gate B), run against the real thing.
//
// It runs the whole Vitest suite of every project the registry (scripts/gate-b.json) names, with the real migrations on
// in-process Postgres (PGlite, no Docker), then checks every sentence of the exit acceptance against the tests that ran:
// each named test must exist, be unambiguous and have passed, and no test in those projects may have failed, been
// skipped or been left todo. A sentence that only a browser can prove names its test in the browser gate's registry
// (apps/person/e2e/acceptance-phase3.json); run `pnpm gate:phase3` for those. Nothing here needs a network.
import { runServerSide } from './gate-server.mjs';

const ok = await runServerSide({ name: 'gate:b', registry: 'scripts/gate-b.json', browser: 'acceptance-phase3.json', timeLimitMs: 9 * 60_000 });
process.exit(ok ? 0 : 1);
