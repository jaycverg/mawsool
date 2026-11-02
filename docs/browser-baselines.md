# Browser gates and their pixel baselines

`pnpm gate:phase2`, `gate:phase3`, `gate:phase4` and `gate:c` drive the real apps in a real Chromium. Some of the checks in
them are pixel snapshots (the person app's screens, the clinic queue and the ops dashboard, in both languages). A snapshot
is only meaningful against a baseline drawn by the same operating system, fonts and Chromium, so each platform has its own
files beside the spec, named by Playwright:

| Platform | Baseline name | Made by | Used by |
| -------- | ------------- | ------- | ------- |
| macOS | `*-chromium-darwin.png` | `E2E_UPDATE_SNAPSHOTS=1 pnpm gate:phase2` (and the other gates) on a Mac | a developer's Mac |
| Linux | `*-chromium-linux.png` | `pnpm e2e:linux --update` | the `browser-gates` job in `.github/workflows/ci.yml` |

A run on a platform with no baseline fails; it never writes one. The macOS files are never changed by the Linux tooling.

## CI

The `browser-gates` job runs each of the four gates in its own job, inside the official Playwright image for the exact
Playwright version the person app pins (`mcr.microsoft.com/playwright:v<version>-noble`), with Node from `.nvmrc` and pnpm from
`packageManager`. Snapshot comparison stays on. `scripts/e2e-linux-lib.test.mjs` (part of `pnpm test:scripts`, so of `verify`)
fails when the workflow's image no longer matches the pinned Playwright version, when a Linux baseline is missing beside a macOS
one, or when the workflow turns snapshot updating on.

## Making or checking the Linux baselines

Needs Docker (OrbStack: `orb start`) and a network. From the repository root:

```
pnpm e2e:linux                    # check: every gate against the committed Linux baselines; changes nothing
pnpm e2e:linux --update           # rewrite the Linux baselines, and copy them back if every gate passed
pnpm e2e:linux --update phase3 c  # only these gates
pnpm e2e:linux --run="pnpm --filter @mawsool/api test"   # any one command in the same container, to look closer at a failure
```

It copies the repository's tracked and not-ignored files into the container (the host's `node_modules` and `.env` never
go in), installs Node and pnpm at the pinned versions, runs `pnpm install --frozen-lockfile` and then the gates. The default
platform is `linux/amd64`, the architecture of GitHub's `ubuntu-latest`, so a baseline made on an Apple Silicon Mac is drawn
by the same build of Chromium CI uses; Docker runs it emulated, which is slow (the four gates take roughly 20 minutes) and may
make the CPU-heavy unit tests inside `gate:c`'s server half time out on a busy machine. `--platform=linux/arm64` is faster and
is for looking, not for making the committed baselines. On a failure it prints where the screenshots and traces of the failed
tests were left.

Commit the changed `*-chromium-linux.png` files with the change that caused them, and look at each one first: a baseline
is an assertion about what the screen looks like.

## When the Playwright version changes

Bump `@playwright/test` in `apps/person/package.json` (an exact version, no range), the image tag in
`.github/workflows/ci.yml`, and regenerate: `pnpm e2e:linux --update`, then, on a Mac, `E2E_UPDATE_SNAPSHOTS=1 pnpm gate:phase2`
and the other gates for the macOS baselines. `scripts/e2e-linux-lib.test.mjs` fails until the workflow and the pin agree.

## What is not verified here

The workflow itself has not been run by a GitHub runner: it was written to match what runs in the container locally, and its
first real run is the first proof. If a baseline made under emulation differs from one drawn natively on a GitHub runner by
more than the 0.5% of pixels `maxDiffPixelRatio` allows, regenerate the Linux baselines from a CI run's own output instead
(the failing job uploads `apps/person/test-results`, which holds the actual screenshots).
