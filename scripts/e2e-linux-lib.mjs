// @ts-check
// The pins `pnpm e2e:linux` and the CI workflow share, read from the files that already pin them, so the Linux baselines
// and the CI run cannot drift apart: the Playwright version (apps/person/package.json), the Node version (.nvmrc) and the
// pnpm version (package.json).

/** The Ubuntu release of the official Playwright image. The image's fonts and libraries come with it, and they decide how a page is drawn. */
export const PLAYWRIGHT_IMAGE_OS = 'noble';

/**
 * The official Playwright image for the exact Playwright version the person app pins. A range is refused: an image that
 * moves with the range would draw differently one day and no one would know why the baselines no longer match.
 * @param {string} personPackageJson the text of apps/person/package.json
 * @returns {{ version: string, image: string }}
 */
export function playwrightImage(personPackageJson) {
  const declared = JSON.parse(personPackageJson).devDependencies?.['@playwright/test'];
  if (typeof declared !== 'string' || !/^\d+\.\d+\.\d+$/.test(declared)) {
    throw new Error(`@playwright/test must be pinned to one exact version in apps/person/package.json, found ${JSON.stringify(declared)}`);
  }
  return { version: declared, image: `mcr.microsoft.com/playwright:v${declared}-${PLAYWRIGHT_IMAGE_OS}` };
}

/**
 * @param {string} nvmrc the text of .nvmrc
 * @returns {string} the Node version, without a leading v
 */
export function nodeVersion(nvmrc) {
  const version = nvmrc.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`.nvmrc must hold one exact Node version, found ${JSON.stringify(nvmrc.trim())}`);
  return version;
}

/**
 * @param {string} rootPackageJson the text of the root package.json
 * @returns {string} the pnpm version
 */
export function pnpmVersion(rootPackageJson) {
  const declared = JSON.parse(rootPackageJson).packageManager;
  const match = typeof declared === 'string' ? /^pnpm@(\d+\.\d+\.\d+)$/.exec(declared) : null;
  if (!match?.[1]) throw new Error(`package.json packageManager must be pnpm@<exact version>, found ${JSON.stringify(declared)}`);
  return match[1];
}

/** The browser gates the Linux baselines cover, by the name after `gate:`. */
export const BROWSER_GATES = Object.freeze(['phase2', 'phase3', 'phase4', 'c']);

/**
 * What the arguments of `pnpm e2e:linux` ask for.
 * @param {string[]} args
 * @returns {{ update: boolean, platform: string, gates: string[], run: string | null }}
 */
export function parseArgs(args) {
  let update = false;
  let platform = 'linux/amd64';
  /** @type {string | null} */
  let run = null;
  /** @type {string[]} */
  const gates = [];
  for (const arg of args) {
    if (arg === '--update') update = true;
    else if (arg.startsWith('--platform=')) platform = arg.slice('--platform='.length);
    else if (arg.startsWith('--run=')) run = arg.slice('--run='.length);
    else if (BROWSER_GATES.includes(arg)) gates.push(arg);
    else throw new Error(`unknown argument "${arg}"; use --update, --platform=linux/amd64|linux/arm64, --run=<command> and any of ${BROWSER_GATES.join(', ')}`);
  }
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error(`--platform must be linux/amd64 or linux/arm64, found ${platform}`);
  // A committed baseline must come from the build CI draws with (amd64). An arm64 container is not that build, so it can be
  // used to look (a check run) but never to write the committed files.
  if (update && platform !== 'linux/amd64') throw new Error(`--update only writes baselines on linux/amd64, the architecture CI draws them on; ${platform} is for checking`);
  if (run !== null && (run.trim() === '' || update || gates.length > 0)) throw new Error('--run=<command> runs one command in the container and takes no gate and no --update');
  return { update, platform, gates: gates.length > 0 ? gates : [...BROWSER_GATES], run };
}
