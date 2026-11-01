// @ts-check
// Pure checks behind `pnpm gate:b`: does a registry of exit-acceptance sentences match what the test runs actually
// ran and passed? Kept apart from the runner so it can be tested, including the cases that must fail.

/**
 * @typedef {{ file: string, name?: string, project?: string }} TestRef
 *   `file` is relative to the project; `project` overrides the entry's. With `name`, exactly one test in that file must match (a substring of its full
 *   name); without `name`, the file must hold at least one test and every one of them must pass.
 * @typedef {{ id: string, sentence: string, project?: string, tests?: TestRef[], browser?: string }} Entry
 *   `project` is the default project of the entry's tests. `browser` names a test id in the browser gate's registry
 *   (`gate:phase3`), for a sentence only a browser can prove.
 * @typedef {{ file: string, fullName: string, status: string }} Result
 * @typedef {Record<string, Result[]>} Reports  project path -> every test result from its run
 */

/**
 * @param {Entry[]} registry
 * @param {Reports} reports
 * @param {string[]} browserIds ids in the browser gate's registry
 * @returns {string[]} one line per problem; empty when every sentence is covered by passing tests
 */
export function evaluateRegistry(registry, reports, browserIds) {
  /** @type {string[]} */
  const problems = [];
  const ids = registry.map((entry) => entry.id);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) problems.push(`${id}: listed twice`);

  const claimed = new Set(registry.flatMap((entry) => (entry.browser ? [entry.browser] : [])));
  for (const id of browserIds) if (!claimed.has(id)) problems.push(`${id}: a browser test that no sentence in this registry claims`);

  for (const entry of registry) {
    const refs = entry.tests ?? [];
    if (refs.length === 0 && !entry.browser) problems.push(`${entry.id}: no test is named for this sentence`);
    if (entry.browser && !browserIds.includes(entry.browser)) problems.push(`${entry.id}: the browser test "${entry.browser}" is not in the browser gate's registry`);
    for (const ref of refs) {
      const project = ref.project ?? entry.project ?? '';
      const results = (reports[project] ?? []).filter((result) => result.file.endsWith(ref.file));
      const label = `${entry.id}: ${project}/${ref.file}${ref.name ? ` "${ref.name}"` : ''}`;
      if (!(project in reports)) {
        problems.push(`${label}: project ${project} was not run`);
        continue;
      }
      const matched = ref.name === undefined ? results : results.filter((result) => result.fullName.includes(/** @type {string} */ (ref.name)));
      if (matched.length === 0) problems.push(`${label}: no such test`);
      else if (ref.name !== undefined && matched.length > 1) problems.push(`${label}: matches ${matched.length} tests, name exactly one`);
      for (const result of matched) if (result.status !== 'passed') problems.push(`${label}: ${result.status} (${result.fullName})`);
    }
  }
  return problems;
}

/**
 * Whether a run counts as having run at all: at least one test, none failed, and nothing skipped or todo.
 * @param {Result[]} results
 * @returns {string | null} the problem, or null
 */
export function runProblem(results) {
  if (results.length === 0) return 'ran no tests';
  const bad = results.filter((result) => result.status !== 'passed');
  return bad.length > 0 ? `${bad.length} test(s) not passed, first: ${bad[0]?.fullName} (${bad[0]?.status})` : null;
}
