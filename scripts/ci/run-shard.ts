import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const [workspace, index, count] = process.argv.slice(2),
	shard = Number(index),
	total = Number(count);
if (
	!['api', 'web'].includes(workspace ?? '') ||
	!Number.isInteger(shard) ||
	!Number.isInteger(total) ||
	shard < 1 ||
	shard > total ||
	total > 16
)
	throw new Error('Invalid shard arguments');
const cwd = `apps/${workspace}`,
	report = `blob-${shard}.json`;
mkdirSync(`${cwd}/.ci-shards`, { recursive: true });
const result = spawnSync(
	'bunx',
	[
		'vitest',
		'run',
		'--coverage',
		'--maxWorkers=2',
		'--reporter=default',
		'--reporter=blob',
		`--outputFile.blob=.vitest-reports/${report}`,
		`--shard=${shard}/${total}`,
	],
	{
		cwd,
		stdio: 'inherit',
		env: { ...process.env, OWLAT_COVERAGE_COLLECT_ONLY: '1' },
	}
);
// A crash without a blob must never produce a successful shard identity.
if (existsSync(`${cwd}/.vitest-reports/${report}`))
	writeFileSync(
		`${cwd}/.ci-shards/${shard}.json`,
		JSON.stringify({
			sha: process.env['GITHUB_SHA'],
			run: process.env['GITHUB_RUN_ID'],
			attempt: process.env['GITHUB_RUN_ATTEMPT'],
			workspace,
			shard,
			total,
			report,
			passed: result.status === 0,
		})
	);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
