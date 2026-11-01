// @ts-check
// `pnpm smoke:dev`: starts `pnpm dev`, waits until the API and all three web apps answer 200,
// prints the result per app, stops the process tree, and exits non-zero if any app never answered.
import { spawn } from 'node:child_process';
import { ROOT, appUrls, killTree, resolveEnv } from './lib.mjs';

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const env = resolveEnv();
const targets = appUrls(/** @type {Record<string, string>} */ (env));

const dev = spawn('node', ['scripts/dev.mjs'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
let devExited = false;
dev.on('exit', () => {
  devExited = true;
});

/** @param {string} url */
async function ok(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

const pending = new Map(targets.map((t) => [t.name, t]));
const deadline = Date.now() + TIMEOUT_MS;
while (pending.size > 0 && Date.now() < deadline && !devExited) {
  for (const [name, target] of [...pending]) {
    if (await ok(target.url)) {
      console.log(`OK    ${name.padEnd(10)} ${target.url}`);
      pending.delete(name);
    }
  }
  if (pending.size > 0) await new Promise((r) => setTimeout(r, 2000));
}

for (const [name, target] of pending) console.log(`FAIL  ${name.padEnd(10)} ${target.url}`);
if (dev.pid && !devExited) await killTree(dev.pid);
process.exit(pending.size === 0 ? 0 : 1);
