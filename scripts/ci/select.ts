import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseTurboTasks, parseTurboWorkspaces } from '../turbo-json';
import { readDockerImages } from './docker-images';
import { coverageWorkspaces, expectedJobs, selectCiWork } from './selection';
const full = process.env['RUN_ALL'] === 'true',
	base = process.env['BASE_SHA'];
if (!full && !base) throw new Error('Affected selection requires BASE_SHA');
const env = { ...process.env, ...(base ? { TURBO_SCM_BASE: base } : {}) };
function turbo(args: string[]): string {
	return execFileSync('bunx', ['turbo', ...args], {
		env,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	});
}
const affected = full ? [] : ['--affected'];
const tasks = parseTurboTasks(
	turbo(['run', 'test:coverage', ...affected, '--dry=json']),
	'turbo run test:coverage --dry=json'
);
const changed = full
	? []
	: execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
			.trim()
			.split('\n');
const images = readDockerImages('.github/docker-images.json');
const names = full
	? []
	: parseTurboWorkspaces(turbo(['ls', ...affected, '--output=json']), 'turbo ls --output=json').map(
			(item) => item.name
		);
const selection = selectCiWork({
	full,
	changed,
	coverage: coverageWorkspaces(tasks),
	affected: names,
	images,
});
const outputs = { ...selection, expected: expectedJobs(selection), full };
const lines = Object.entries(outputs)
	.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
	.join('\n');
if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `${lines}\n`);
else process.stdout.write(`${lines}\n`);
