// @ts-check
// `pnpm e2e:linux [--update] [--platform=linux/amd64|linux/arm64] [phase2|phase3|phase4|c ...]`
//
// Runs the browser gates in the official Playwright container, the one the CI workflow runs them in, so the pixel
// snapshots can be made and checked for Linux from any machine. With no gate named it runs all four.
//
//   - without `--update` it only checks: the committed `*-chromium-linux.png` baselines are held against a fresh render and
//     nothing in the repository changes;
//   - with `--update` it rewrites the Linux baselines (`E2E_UPDATE_SNAPSHOTS=1`) and, if every gate passed, copies them back
//     beside the macOS ones. The macOS baselines (`*-chromium-darwin.png`) are never touched: Playwright names a baseline
//     by platform, so a Linux run can only read and write the Linux ones.
//
// The image is `mcr.microsoft.com/playwright:v<exact Playwright version>-noble`, Node is the one in `.nvmrc` and pnpm the one
// `packageManager` pins; the CI workflow uses the same three, and `scripts/lib.test.mjs` fails when it does not. The default
// platform is linux/amd64, the architecture of GitHub's `ubuntu-latest`, so a baseline made on an Apple Silicon Mac is drawn
// by the same build of Chromium that CI will use (it runs emulated and takes longer). The working copy is the repository's
// tracked and not-ignored files, copied in, so the host's node_modules and .env never reach the container.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { nodeVersion, parseArgs, playwrightImage, pnpmVersion } from './e2e-linux-lib.mjs';

/** Where the baselines live, relative to the repository. */
const E2E_DIR = 'apps/person/e2e';

const log = (/** @type {string} */ message) => console.log(`[e2e:linux] ${message}`);
const read = (/** @type {string} */ file) => readFileSync(resolve(ROOT, file), 'utf8');

/** What runs inside the container; it takes its inputs from the environment and from /io. */
const INNER_SCRIPT = resolve(ROOT, 'scripts/e2e-linux-inner.sh');

/** The repository's tracked and not-ignored files, as a null-separated list that exists on disk. */
function sourceFiles() {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error('git ls-files failed');
  return listed.stdout
    .toString('utf8')
    .split('\0')
    .filter((file) => file !== '' && existsSync(resolve(ROOT, file)) && !statSync(resolve(ROOT, file)).isDirectory());
}

function main() {
  const { update, platform, gates, run } = parseArgs(process.argv.slice(2));
  const { image, version } = playwrightImage(read('apps/person/package.json'));
  const node = nodeVersion(read('.nvmrc'));
  const pnpm = pnpmVersion(read('package.json'));
  if (spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) {
    log('Docker is not available. Start it (OrbStack: `orb start`); this is never skipped.');
    return 1;
  }

  /** True when the container's CPU is not the host's, so everything inside runs emulated. */
  const emulated = (platform === 'linux/amd64') !== (process.arch === 'x64');
  const io = mkdtempSync(join(tmpdir(), 'mawsool-e2e-linux-'));
  const files = sourceFiles();
  writeFileSync(join(io, 'files.list'), files.join('\0') + '\0');
  const packed = spawnSync('tar', ['--null', '-T', join(io, 'files.list'), '-cf', join(io, 'src.tar')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (packed.status !== 0) return 1;
  log(`${files.length} files, image ${image} on ${platform}, Node ${node}, pnpm ${pnpm}, ${run ? `running "${run}"` : `gates ${gates.join(', ')}${update ? ', rewriting the Linux baselines' : ', checking the committed Linux baselines'}`}`);

  const ran = spawnSync(
    'docker',
    [
      'run', '--rm', '--platform', platform, '--ipc=host',
      '-v', `${io}:/io`,
      '-v', `${INNER_SCRIPT}:/inner.sh:ro`,
      '-v', `mawsool-e2e-linux-pnpm-store-${platform.replace('/', '-')}:/pnpm-store`,
      '-e', `NODE_VERSION=${node}`, '-e', `PNPM_VERSION=${pnpm}`, '-e', `GATES=${gates.join(' ')}`, '-e', 'CI=true',
      // Emulated, the PGlite-backed unit tests inside gate:c's server half are several times slower and fight each other for the CPU,
      // so the one CPU-heavy test (4,500 random tables) can pass its 30 s limit; fewer workers keep each file's share larger.
      ...(emulated ? ['-e', 'VITEST_MAX_WORKERS=2'] : []),
      ...(run ? ['-e', `RUN_COMMAND=${run}`] : []),
      ...(update ? ['-e', 'E2E_UPDATE_SNAPSHOTS=1'] : []),
      image, 'bash', '/inner.sh',
    ],
    { stdio: 'inherit' },
  );
  if (ran.status !== 0) {
    log(`did not pass (exit ${ran.status ?? ran.signal}); the repository was left as it was`);
    log(`screenshots and traces of the failed tests (Playwright ${version}): tar -xf ${join(io, 'test-results.tar')} -C <a folder>`);
    return 1;
  }
  if (run) return 0;
  if (update) {
    const unpacked = spawnSync('tar', ['-xf', join(io, 'snapshots.tar'), '-C', resolve(ROOT, E2E_DIR)], { stdio: 'inherit' });
    if (unpacked.status !== 0) return 1;
    log(`the Linux baselines are written under ${E2E_DIR}; commit them beside the macOS ones`);
  } else {
    log('every gate passed against the committed Linux baselines');
  }
  return 0;
}

process.exit(main());
