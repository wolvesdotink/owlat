import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import type { Workspace } from './selection';
const group = JSON.parse(process.env['CI_GROUP'] ?? 'null') as { workspaces: Workspace[] } | null;
if (!group?.workspaces.length) throw new Error('Empty CI test group');
const filters = group.workspaces.map((workspace) => {
	if (
		!/^@owlat\/[a-z0-9-]+$/.test(workspace.package) ||
		!/^(?:apps|packages|examples)\/[a-z0-9/-]+$/.test(workspace.directory) ||
		!existsSync(`${workspace.directory}/package.json`)
	)
		throw new Error('Invalid CI test group workspace');
	return `--filter=${workspace.package}`;
});
if (process.env['GITHUB_OUTPUT'])
	appendFileSync(
		process.env['GITHUB_OUTPUT'],
		`paths<<COVERAGE_PATHS\n${group.workspaces.map((w) => `${w.directory}/coverage/`).join('\n')}\nCOVERAGE_PATHS\n`
	);
execFileSync(
	'bunx',
	[
		'turbo',
		'run',
		'test:coverage',
		'--concurrency=2',
		...filters,
		...(process.env['CI_FULL'] === 'true' ? ['--force'] : []),
	],
	{
		stdio: 'inherit',
		env: { ...process.env, VITEST_MAX_WORKERS: '2' },
	}
);
