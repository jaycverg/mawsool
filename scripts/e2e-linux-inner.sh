#!/bin/bash
# What `pnpm e2e:linux` runs inside the Playwright container (see scripts/e2e-linux.mjs). Not meant to be run by hand.
# Inputs: /io/src.tar (the repository's files), NODE_VERSION, PNPM_VERSION and GATES (names after `gate:`) in the
# environment, and /pnpm-store as the package store. Output: /io/snapshots.tar holds every Linux baseline the run left.
set -eu

mkdir -p /work
tar -xf /io/src.tar -C /work

# The image carries the browser and the fonts; Node is the repository's pinned version, from nodejs.org, checked against
# the published checksum.
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
NODE_DIR="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
cd /tmp
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIR}.tar.gz" -o node.tgz
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${NODE_DIR}.tar.gz\$" | sed "s/${NODE_DIR}.tar.gz/node.tgz/" | sha256sum -c -
tar -xzf node.tgz -C /opt
export PATH="/opt/${NODE_DIR}/bin:$PATH"
test "$(node -v)" = "v${NODE_VERSION}"
npm install -g "pnpm@${PNPM_VERSION}" --silent

cd /work
cp .env.example .env
pnpm install --frozen-lockfile --store-dir /pnpm-store

status=0

# One gate's exit code, as this run counts it. A gate that rewrote the baselines and otherwise passed exits 3 (an update run
# is never an acceptance result), which only a run that asked for the rewrite accepts.
gate_status() {
  if [ "$1" -eq 3 ] && [ "${E2E_UPDATE_SNAPSHOTS:-}" = "1" ]; then return 0; fi
  return "$1"
}

if [ -n "${RUN_COMMAND:-}" ]; then
  # To look closer at one thing in the same container (`pnpm e2e:linux --run="pnpm --filter @mawsool/api test"`).
  echo "== ${RUN_COMMAND} (node $(node -v), $(uname -m))"
  bash -c "$RUN_COMMAND" || status=1
else
  for gate in $GATES; do
    echo "== gate:$gate (node $(node -v), $(uname -m))"
    pnpm "gate:$gate" || gate_status $? || status=1
  done
fi

# What a failed browser test left (screenshots, traces), and every Linux baseline the run holds.
tar -cf /io/test-results.tar -C /work/apps/person test-results 2>/dev/null || true
cd /work/apps/person/e2e
find . -name '*-chromium-linux.png' -print0 | tar --null -T - -cf /io/snapshots.tar || true
exit $status
