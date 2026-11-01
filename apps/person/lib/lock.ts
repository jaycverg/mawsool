import type { StorageAdapter } from '@mawsool/ui';

const tails = new WeakMap<StorageAdapter, Promise<unknown>>();

/**
 * Runs `task` after every earlier task on the same store has finished, whether it succeeded or not. Read-then-write
 * updates (saving an answer, updating the crisis record, editing the queue) go through here, so two quick taps
 * cannot each read the old value and overwrite the other's write.
 */
export function withStoreLock<T>(storage: StorageAdapter, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(storage) ?? Promise.resolve();
  const run = previous.then(task, task);
  tails.set(storage, run.catch(() => undefined));
  return run;
}
