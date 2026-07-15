import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface TurboTask {
	readonly taskId: string;
	readonly dependencies: readonly string[];
}

interface TurboDryRun {
	readonly tasks: readonly TurboTask[];
}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dryRun = spawnSync(
	process.execPath,
	['x', 'turbo', 'run', 'deploy', '--filter=@owlat/api', '--dry=json'],
	{
		cwd: workspaceRoot,
		encoding: 'utf8',
	}
);
if (dryRun.error) throw dryRun.error;
if (dryRun.status !== 0) {
	throw new Error(`Plugin deploy graph inspection failed: ${dryRun.stderr.trim()}`);
}

const graph = JSON.parse(dryRun.stdout) as TurboDryRun;
const tasks = new Map(graph.tasks.map((task) => [task.taskId, task.dependencies]));
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
