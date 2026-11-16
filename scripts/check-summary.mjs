// @ts-check
// `pnpm check:summary`: asks the running API for referral-summary drafts, three in English and three in Arabic, and holds
// each to the rules in check-summary-lib.mjs: written by the assistant, in time for the phone, short enough to edit, ending
// cleanly, free of the note the person did not tick, in the asked language, and free of listed terms. Run it against
// `pnpm dev` with the assistant on (SUMMARY_LLM_ENABLED, SUMMARY_PROVIDER and the provider's key in .env) before showing it.
//
// It sends sample data only and prints each draft, its time and its checks; it never prints a setting's value. It leaves one
// throwaway device and six unclaimed drafts in the API's database: the sweep deletes the drafts after 24 hours and
// "Reset the demo" in the ops app deletes the device. Exits non-zero if any draft fails a rule or any request fails.
import { randomUUID } from 'node:crypto';
import { resolveEnv } from './lib.mjs';
import { checkDraft, draftRequest, nonLoopbackHost, templateHint, throwawayDevice, wordCount } from './check-summary-lib.mjs';

const DRAFTS_PER_LANGUAGE = 3;
const REQUEST_TIMEOUT_MS = 20_000;

const env = resolveEnv();
const host = env.API_HOST ?? '127.0.0.1';
const refusal = nonLoopbackHost(host);
if (refusal) {
  console.error(`check:summary: ${refusal}. It sends sample content and only runs against a local API.`);
  process.exit(2);
}
const api = `http://${host}:${env.API_PORT}`;

/**
 * @param {string} path
 * @param {unknown} body
 * @param {string} [authorization]
 */
async function post(path, body, authorization) {
  const started = performance.now();
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const elapsedMs = performance.now() - started;
  return { status: response.status, json: /** @type {any} */ (await response.json().catch(() => null)), elapsedMs };
}

const device = throwawayDevice();
try {
  const registered = await post('/persons', { id: device.id, secret: device.secret, locale: 'en' });
  if (registered.status !== 201) throw new Error(`registering a throwaway device answered ${registered.status}`);
} catch (error) {
  console.error(`check:summary: could not reach the API at ${api} (${error instanceof Error ? error.message : String(error)}). Start pnpm dev first.`);
  process.exit(2);
}

let failed = 0;
let sawTemplate = false;
/** @type {import('./check-summary-lib.mjs').Draft | null} */
let firstTemplate = null;

for (const locale of /** @type {const} */ (['en', 'ar'])) {
  for (let n = 1; n <= DRAFTS_PER_LANGUAGE; n += 1) {
    const label = `${locale} #${n}`;
    let result;
    try {
      result = await post('/summary/draft', draftRequest(locale, randomUUID()), device.authorization);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${label}  the request failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.status !== 200 || typeof result.json?.text !== 'string') {
      failed += 1;
      console.log(`FAIL  ${label}  the API answered ${result.status}`);
      continue;
    }
    const draft = /** @type {import('./check-summary-lib.mjs').Draft} */ (result.json);
    const problems = checkDraft({ locale, draft, elapsedMs: result.elapsedMs });
    if (draft.source === 'template') {
      sawTemplate = true;
      firstTemplate ??= draft;
    }
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${label}  ${(result.elapsedMs / 1000).toFixed(1)} s, source ${draft.source}, ${wordCount(draft.text)} words`);
    console.log(draft.text.split('\n').map((line) => `        ${line}`).join('\n'));
    for (const problem of problems) console.log(`      - ${problem.rule}: ${problem.message}`);
    if (problems.length > 0) failed += 1;
  }
}

if (sawTemplate && firstTemplate) console.log(`\n${templateHint(firstTemplate).join('\n')}`);
const total = 2 * DRAFTS_PER_LANGUAGE;
console.log(`\n${total - failed} of ${total} drafts passed. The script cannot judge tone or a condition named in other words: read the drafts above.`);
process.exit(failed === 0 ? 0 : 1);
