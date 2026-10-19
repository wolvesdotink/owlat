import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import {
	coverageWorkspaces,
	desktopSpaSelected,
	expectedJobs,
	groupWorkspaces,
	type Task,
} from './selection';
const full = process.env['RUN_ALL'] === 'true',
	base = process.env['BASE_SHA'];
if (!full && !base) throw new Error('Affected selection requires BASE_SHA');
const env = { ...process.env, ...(base ? { TURBO_SCM_BASE: base } : {}) };
function turbo(args: string[]) {
	return JSON.parse(
		execFileSync('bunx', ['turbo', ...args], {
			env,
			encoding: 'utf8',
			maxBuffer: 256 * 1024 * 1024,
		})
	);
}
const affected = full ? [] : ['--affected'];
const tasks = turbo(['run', 'test:coverage', ...affected, '--dry=json']) as { tasks: Task[] };
const workspaces = coverageWorkspaces(tasks.tasks),
	groups = groupWorkspaces(workspaces);
const changed = full
	? []
	: execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
			.trim()
			.split('\n');
const images = JSON.parse(readFileSync('.github/docker-images.json', 'utf8')) as {
	package: string;
	dockerfile: string;
}[];
const names = full
	? []
	: (
			turbo(['ls', ...affected, '--output=json']) as { packages: { items: { name: string }[] } }
		).packages.items.map((item) => item.name);
const web = workspaces.some((w) => w.name === 'web');
const selection = {
	groups,
	api: workspaces.some((w) => w.name === 'api'),
	web,
	mta: workspaces.some((w) => w.name === 'mta'),
	images:
		full || changed.includes('.github/docker-images.json')
			? images
			: images.filter(
					(image) => names.includes(image.package) || changed.includes(image.dockerfile)
				),
	java: full || changed.some((file) => file.startsWith('packages/sdk-java/')),
	desktopSpa: desktopSpaSelected(full, web, changed),
};
const outputs = { ...selection, expected: expectedJobs(selection), full };
const lines = Object.entries(outputs)
	.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
	.join('\n');
if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `${lines}\n`);
else process.stdout.write(`${lines}\n`);
