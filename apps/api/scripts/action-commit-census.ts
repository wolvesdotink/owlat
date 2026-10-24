/**
 * The generator half of `check-action-commits.sh`: prints one ratchet entry
 * per commit past the first for every action under `convex/` (see
 * `lib/actionCommits.ts` for how commits are counted), and fails on a
 * `// checkpoint:` marker that exempts nothing or gives no reason.
 *
 *   bun scripts/action-commit-census.ts           ratchet entries
 *   bun scripts/action-commit-census.ts --counts  `<commits> <module>:<action>`, worst first
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { censusLines, censusModule, type ActionCommitCount } from './lib/actionCommits';
import { productionModules } from './lib/sourceGraph';

const apiRoot = join(import.meta.dirname, '..');
const convexRoot = join(apiRoot, 'convex');

const actions: ActionCommitCount[] = [];
const problems: string[] = [];
for (const file of productionModules(convexRoot)) {
	const module = relative(apiRoot, file).split('\\').join('/');
	const census = censusModule(module, readFileSync(file, 'utf8'));
	actions.push(...census.actions);
	problems.push(...census.problems);
}

if (actions.length < 50) problems.push(`found only ${actions.length} actions under convex/`);
if (problems.length > 0) {
	for (const problem of problems) console.error(`FAIL: ${problem}`);
	process.exit(1);
}

if (process.argv.includes('--counts')) {
	for (const action of [...actions].sort((a, b) => b.commits - a.commits)) {
		if (action.commits > 1) console.info(`${action.commits} ${action.module}:${action.name}`);
	}
} else {
	for (const line of censusLines(actions)) console.info(line);
}
