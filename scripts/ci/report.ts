import { github, githubPages, repository } from './github';
import { distribution, jobMetrics, type JobTiming } from './metrics';
const repo = repository();
const workflows = [
	['test.yml', 100],
	['release.yml', 10],
	['desktop-release.yml', 5],
	['server-release.yml', 5],
] as const;
interface Run {
	id: number;
	name: string;
	event: string;
	head_sha: string;
	head_branch: string;
	run_attempt: number;
	created_at: string;
	run_started_at: string;
	updated_at: string;
	status: string;
	conclusion: string | null;
	html_url: string;
}
interface Release {
	tag_name: string;
	published_at: string | null;
}
const releases = githubPages<Release>(`repos/${repo}/releases?per_page=100`);
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
	const runs = github<{ workflow_runs: Run[] }>(
		`repos/${repo}/actions/workflows/${workflow}/runs?per_page=${limit}`
	).workflow_runs;
	for (const run of runs.filter((r) => r.status === 'completed')) {
		const jobs = githubPages<{ jobs: JobTiming[] }>(
			`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
		).flatMap((page) => page.jobs);
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
					: github<Run>(`repos/${repo}/actions/runs/${run.id}/attempts/1`).conclusion,
			url: run.html_url,
			attemptMinutes: (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 60_000,
			tagToPublishMinutes: tag?.published_at
				? (Date.parse(tag.published_at) - Date.parse(run.created_at)) / 60_000
				: null,
			...jobMetrics(jobs),
		});
	}
}
const cache = github<{ active_caches_size_in_bytes: number; active_caches_count: number }>(
	`repos/${repo}/actions/cache/usage`
);
const cachePages = githubPages<{ actions_caches: { ref: string; size_in_bytes: number }[] }>(
	`repos/${repo}/actions/caches?per_page=100`
);
const cacheByRef: Record<string, number> = {};
for (const c of cachePages.flatMap((page) => page.actions_caches))
	cacheByRef[c.ref] = (cacheByRef[c.ref] ?? 0) + c.size_in_bytes;
const categories = [...new Set(rows.map((r) => `${r.workflow}:${r.event}`))];
process.stdout.write(
	JSON.stringify(
		{
			repository: repo,
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
