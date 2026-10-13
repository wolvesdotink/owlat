import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { assertShards, type ShardIdentity } from './shards';
const [workspace, count] = process.argv.slice(2),
	total = Number(count);
if (
	!['api', 'web'].includes(workspace ?? '') ||
	!Number.isInteger(total) ||
	total < 1 ||
	total > 16
)
	throw new Error('Invalid merge arguments');
const cwd = `apps/${workspace}`,
	download = `${cwd}/.ci-downloads`;
const latest = new Map<number, { identity: ShardIdentity; directory: string }>();
for (const directory of readdirSync(download)) {
	const match = new RegExp(`^${workspace}-blob-(\\d+)-attempt-(\\d+)$`).exec(directory);
	if (!match) throw new Error('Unexpected shard artifact');
	const identity = JSON.parse(
		readFileSync(`${download}/${directory}/.ci-shards/${match[1]}.json`, 'utf8')
	) as ShardIdentity;
	if (String(identity.shard) !== match[1] || identity.attempt !== match[2])
		throw new Error('Artifact identity mismatch');
	const previous = latest.get(identity.shard);
	if (!previous || Number(identity.attempt) > Number(previous.identity.attempt))
		latest.set(identity.shard, { identity, directory });
}
const identities = [...latest.values()].map((value) => value.identity);
const reports = [...latest.values()].flatMap((value) =>
	readdirSync(`${download}/${value.directory}/.vitest-reports`)
);
assertShards(
	identities,
	{
		sha: process.env['GITHUB_SHA']!,
		run: process.env['GITHUB_RUN_ID']!,
		attempt: process.env['GITHUB_RUN_ATTEMPT']!,
		workspace: workspace!,
		total,
		passed: true,
	},
	reports
);
rmSync(`${cwd}/.vitest-reports`, { recursive: true, force: true });
mkdirSync(`${cwd}/.vitest-reports`);
for (const { identity, directory } of latest.values())
	cpSync(
		`${download}/${directory}/.vitest-reports/${identity.report}`,
		`${cwd}/.vitest-reports/${identity.report}`
	);
const env = { ...process.env };
delete env['OWLAT_COVERAGE_COLLECT_ONLY'];
execFileSync('bunx', ['vitest', '--merge-reports', '--coverage'], { cwd, env, stdio: 'inherit' });
