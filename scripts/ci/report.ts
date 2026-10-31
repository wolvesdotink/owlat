import { arrayOf, type Decoder, integer, nullable, number, object, string } from '../json';
import { github, githubPages, repository } from './github';
import { distribution, jobMetrics, type JobTiming } from './metrics';
const repo = repository();
const runLimit = Number(process.env['CI_REPORT_RUNS'] ?? 100);
if (!Number.isInteger(runLimit) || runLimit < 1 || runLimit > 100)
	throw new Error('CI_REPORT_RUNS must be 1–100');
const workflows = [
	['test.yml', runLimit],
	['release.yml', 10],
	['desktop-release.yml', 5],
	['server-release.yml', 5],
] as const;
const decodeRun = object({
	id: integer,
	name: string,
	event: string,
	head_sha: string,
	head_branch: nullable(string),
	run_attempt: integer,
	created_at: string,
	run_started_at: string,
	updated_at: string,
	status: string,
	conclusion: nullable(string),
	html_url: string,
});
const decodeJob: Decoder<JobTiming> = object({
	name: string,
	created_at: string,
	started_at: nullable(string),
	completed_at: nullable(string),
	conclusion: nullable(string),
});
const releases = githubPages(
	`repos/${repo}/releases?per_page=100`,
	arrayOf(object({ tag_name: string, published_at: nullable(string) }))
);
const rows: ({
	workflow: string;
	id: number;
	sha: string;
	event: string;
	conclusion: string | null;
	attempts: number;
	firstAttemptConclusion: string | null;
	url: string;
	attemptMinutes: number;
	tagToPublishMinutes: number | null;
} & ReturnType<typeof jobMetrics>)[] = [];
for (const [workflow, limit] of workflows) {
	const { workflow_runs: runs } = github(
		`repos/${repo}/actions/workflows/${workflow}/runs?per_page=${limit}`,
		object({ workflow_runs: arrayOf(decodeRun) })
	);
	for (const run of runs.filter((r) => r.status === 'completed')) {
		const jobs = githubPages(
			`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
			(page, path) => object({ jobs: arrayOf(decodeJob) })(page, path).jobs
		);
		const tag = releases.find((r) => r.tag_name === run.head_branch);
		rows.push({
			workflow,
			id: run.id,
			sha: run.head_sha,
			event: run.event,
			conclusion: run.conclusion,
			attempts: run.run_attempt,
			firstAttemptConclusion:
				run.run_attempt === 1
					? run.conclusion
					: github(`repos/${repo}/actions/runs/${run.id}/attempts/1`, decodeRun).conclusion,
			url: run.html_url,
			attemptMinutes: (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 60_000,
			tagToPublishMinutes: tag?.published_at
				? (Date.parse(tag.published_at) - Date.parse(run.created_at)) / 60_000
				: null,
			...jobMetrics(jobs),
		});
	}
}
const cache = github(
	`repos/${repo}/actions/cache/usage`,
	object({ active_caches_size_in_bytes: number, active_caches_count: integer })
);
const caches = githubPages(
	`repos/${repo}/actions/caches?per_page=100`,
	(page, path) =>
		object({ actions_caches: arrayOf(object({ ref: string, size_in_bytes: number })) })(page, path)
			.actions_caches
);
const cacheByRef: Record<string, number> = {};
for (const c of caches) cacheByRef[c.ref] = (cacheByRef[c.ref] ?? 0) + c.size_in_bytes;
const categories = [...new Set(rows.map((r) => `${r.workflow}:${r.event}`))];
process.stdout.write(
	JSON.stringify(
		{
			repository: repo,
			jobMinutesScope: 'latest-attempt',
			capturedAt: new Date().toISOString(),
			cache,
			cacheByRef,
			distributions: Object.fromEntries(
				categories.map((category) => [
					category,
					distribution(
						rows
							.filter((r) => `${r.workflow}:${r.event}` === category && r.conclusion === 'success')
							.map((r) => r.attemptMinutes)
					),
				])
			),
			runs: rows,
		},
		null,
		2
	) + '\n'
);
