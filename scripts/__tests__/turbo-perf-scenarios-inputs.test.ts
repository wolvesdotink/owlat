/**
 * The component performance scenarios' limits (plan item OW-073) live in one
 * root module, scripts/perf-scenarios/writerLimits.ts, imported from inside
 * apps/web and apps/api. turbo hashes only a package's own directory by
 * default, so turbo.json lists that module as an input of each importing
 * workspace's `test`, `test:coverage` and `typecheck`. This finds every file
 * that imports it and checks the real `turbo run --dry=json` input lists,
 * so it fails when a new workspace starts importing it or an override is
 * dropped.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MODULE = 'scripts/perf-scenarios/writerLimits.ts';
const TASKS = ['test', 'test:coverage', 'typecheck'] as const;

/** The workspace (package name) of every source file in apps/ or packages/ that imports MODULE. */
function importingWorkspaces(): string[] {
	const files = execFileSync(
		'git',
		[
			'grep',
			'-lE',
			'--untracked',
			"from '(\\.\\./)+scripts/perf-scenarios/writerLimits'",
			'--',
			'apps',
			'packages',
		],
		{
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		}
	)
		.split('\n')
		.filter(Boolean);
	const workspaces = new Set<string>();
	for (const file of files) {
		const [area, dir] = file.split('/');
		const manifest = JSON.parse(
			readFileSync(join(REPOSITORY_ROOT, area as string, dir as string, 'package.json'), 'utf8')
		) as { name: string };
		workspaces.add(manifest.name);
	}
	return [...workspaces].sort();
}

interface DryRunTask {
	readonly task: string;
	readonly package: string;
	readonly directory: string;
	readonly inputs: Readonly<Record<string, string>>;
}

const workspaces = importingWorkspaces();
let inputs: Map<string, Set<string>>;

beforeAll(() => {
	const dryRun = JSON.parse(
		execFileSync(
			join(REPOSITORY_ROOT, 'node_modules/.bin/turbo'),
			['run', ...TASKS, '--dry=json', ...workspaces.map((w) => `--filter=${w}`)],
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

describe('turbo inputs for the perf-scenario writer limits', () => {
	it('is imported by the web scenarios and the api contract test', () => {
		expect(workspaces).toEqual(['@owlat/api', '@owlat/web']);
	});

	it.each(workspaces.flatMap((w) => TASKS.map((task) => ({ key: `${w}#${task}` }))))(
		'$key hashes the module',
		({ key }) => {
			const files = inputs.get(key);
			expect(files, `${key} is missing from the dry run`).toBeDefined();
			expect(files?.has(MODULE), `${key} does not hash ${MODULE}`).toBe(true);
		}
	);
});
