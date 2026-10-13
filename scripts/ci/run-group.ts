import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Workspace } from './selection';
const group = JSON.parse(process.env['CI_GROUP'] ?? 'null') as { workspaces: Workspace[] } | null;
if (!group?.workspaces.length) throw new Error('Empty CI test group');
const filters = group.workspaces.map((workspace) => {
	if (
		!/^@owlat\/[a-z0-9-]+$/.test(workspace.package) ||
		!existsSync(`${workspace.directory}/package.json`)
	)
		throw new Error('Invalid CI test group workspace');
	return `--filter=${workspace.package}`;
});
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
