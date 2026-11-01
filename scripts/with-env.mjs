// @ts-check
// Usage: node scripts/with-env.mjs <command> [args...]
// Runs the command with .env loaded and every port, URL and Compose setting derived from PORT_OFFSET.
import { spawn } from 'node:child_process';
import { ROOT, resolveEnv } from './lib.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}

const child = spawn(command, args, { cwd: ROOT, env: resolveEnv(), stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
