import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dryRun = spawnSync(
	process.execPath,
	['x', 'turbo', 'run', 'deploy', '--filter=@owlat/api', '--dry=json'],
	{
		cwd: workspaceRoot,
		encoding: 'utf8',
		// The dry-run JSON lists every repo file as a task input, so it outgrows
		// the 1 MiB default buffer as the tree grows.
		maxBuffer: 64 * 1024 * 1024,
	}
);
if (dryRun.error) throw dryRun.error;
if (dryRun.status !== 0) {
	throw new Error(`Plugin deploy graph inspection failed: ${dryRun.stderr.trim()}`);
}

const tasks = taskDependencies(JSON.parse(dryRun.stdout));
assertDependencies(tasks, '@owlat/api#deploy', ['//#plugins:check', '@owlat/plugin-host#build']);
assertDependencies(tasks, '@owlat/plugin-host#build', ['@owlat/plugin-kit#build']);

console.info('API deploys gate composition freshness and build the plugin runtime contract.');

function assertDependencies(
	tasks: ReadonlyMap<string, readonly string[]>,
	taskId: string,
	requiredDependencies: readonly string[]
): void {
	const dependencies = tasks.get(taskId);
	if (!dependencies) throw new Error(`Plugin deploy graph is missing ${taskId}`);
	const missing = requiredDependencies.filter((dependency) => !dependencies.includes(dependency));
	if (missing.length > 0) {
		throw new Error(`${taskId} is missing required dependencies: ${missing.join(', ')}`);
	}
}

/**
 * Each task's dependencies in a `turbo run --dry=json` report. A report of
 * another shape fails the smoke: a task this cannot read is not a task whose
 * dependencies are known.
 */
function taskDependencies(report: unknown): Map<string, readonly string[]> {
	const listed = isObject(report) ? report['tasks'] : undefined;
	if (!Array.isArray(listed)) throw new Error('Turbo dry run did not list its tasks');
	const tasks = new Map<string, readonly string[]>();
	for (const task of listed) {
		const taskId = isObject(task) ? task['taskId'] : undefined;
		const dependencies = isObject(task) ? task['dependencies'] : undefined;
		if (
			typeof taskId !== 'string' ||
			!Array.isArray(dependencies) ||
			!dependencies.every((dependency) => typeof dependency === 'string')
		) {
			throw new Error('Turbo dry run listed a task without an id or dependencies');
		}
		tasks.set(taskId, dependencies);
	}
	return tasks;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
