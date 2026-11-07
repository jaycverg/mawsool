// @ts-check
// What a browser gate (`scripts/e2e-gate.mjs`) exits with, apart from the gate itself so a test can hold it.

/**
 * The exit code of a gate whose run rewrote the pixel baselines (`E2E_UPDATE_SNAPSHOTS=1`) and otherwise passed. It is not
 * zero, because a run that writes its own baselines compares nothing and proves nothing: an update run is never an
 * acceptance result. `pnpm e2e:linux --update` is the one caller that accepts it (see `gate_status` in e2e-linux-inner.sh).
 */
export const UPDATE_RUN_EXIT_CODE = 3;

/**
 * Whether a run rewrites the baselines. `1` is the one value Playwright's config reads as on (apps/person/playwright.config.ts).
 * @param {Record<string, string | undefined>} env
 */
export function isUpdateRun(env) {
  return env.E2E_UPDATE_SNAPSHOTS === '1';
}

/**
 * The exit code and the line to print for a finished browser run.
 * @param {{ updating: boolean, playwrightStatus: number, problems: readonly string[] }} run `problems` are the registry checks that failed
 * @returns {{ code: number, note: string | null }}
 */
export function gateOutcome({ updating, playwrightStatus, problems }) {
  const clean = playwrightStatus === 0 && problems.length === 0;
  if (!updating) return { code: clean ? 0 : 1, note: null };
  return {
    code: clean ? UPDATE_RUN_EXIT_CODE : 1,
    note: `update run (E2E_UPDATE_SNAPSHOTS=1): the pixel baselines were rewritten and nothing was compared against them, so this is not an acceptance result; run the gate again without it`,
  };
}
