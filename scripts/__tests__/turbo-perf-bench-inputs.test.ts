/**
 * The report-only benchmark specs (plan item OW-072) import root files under
 * scripts/perf-bench/, outside the workspace turbo hashes by default. turbo.json
 * adds that directory to the inputs of the generic `test`, `test:coverage` and
 * `typecheck` tasks, so a change to one of those files alone cannot replay a
 * cached result. This reads which perf-bench files each spec really imports
 * and checks them against the real `turbo run --dry=json` input lists of the
 * importing workspace, so it fails when the inputs are dropped or narrowed
 * past a file a spec imports.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Each spec that imports from scripts/perf-bench/, by the workspace that runs it. */
const SPECS = [
	{ workspace: '@owlat/web', spec: 'apps/web/app/lib/__tests__/structuralSharing.perf.test.ts' },
	{
		workspace: '@owlat/email-builder',
		spec: 'packages/email-builder/src/composables/__tests__/usePreview.perf.test.ts',
	},
	{
		workspace: '@owlat/api',
		spec: 'apps/api/convex/mail/__tests__/perfListFixtureContract.test.ts',
	},
] as const;

/** Every task whose result depends on what the specs import. */
const TASKS = ['test', 'test:coverage', 'typecheck'] as const;

interface DryRunTask {
	readonly task: string;
	readonly package: string;
	readonly directory: string;
	readonly inputs: Readonly<Record<string, string>>;
}

/** Repo-relative input files per `package#task`. */
let inputs: Map<string, Set<string>>;

beforeAll(() => {
	const dryRun = JSON.parse(
		execFileSync(
			join(REPOSITORY_ROOT, 'node_modules/.bin/turbo'),
			['run', ...TASKS, '--dry=json', ...SPECS.map(({ workspace }) => `--filter=${workspace}`)],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
		)
	) as { tasks: DryRunTask[] };
	inputs = new Map(
		dryRun.tasks.map((task) => [
			`${task.package}#${task.task}`,
			new Set(Object.keys(task.inputs).map((file) => normalize(join(task.directory, file)))),
		])
	);
}, 120_000);

/** The scripts/perf-bench/ files a spec imports, repo-relative. */
function perfBenchImports(spec: string): string[] {
	const source = readFileSync(join(REPOSITORY_ROOT, spec), 'utf8');
	return [...source.matchAll(/from '(?:\.\.\/)+scripts\/perf-bench\/([\w-]+)'/g)].map(
		(match) => `scripts/perf-bench/${match[1]}.ts`
	);
}

describe('turbo test and typecheck inputs for the perf-bench imports', () => {
	it.each(SPECS)('$workspace hashes every perf-bench file $spec imports', ({ workspace, spec }) => {
		const imported = perfBenchImports(spec);
		expect(imported.length).toBeGreaterThan(0);
		for (const task of TASKS) {
			const files = inputs.get(`${workspace}#${task}`);
			expect(files, `${workspace}#${task} is missing from the dry run`).toBeDefined();
			for (const file of imported) {
				expect(files?.has(file), `${workspace}#${task} does not hash ${file}`).toBe(true);
			}
		}
	});
});
