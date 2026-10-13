export interface JobTiming {
	name: string;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	conclusion: string | null;
}
export function jobMetrics(jobs: JobTiming[]) {
	const completed = jobs.filter(
		(j) => j.started_at && j.completed_at && j.conclusion !== 'skipped'
	);
	const durations = completed.map((j) => ({
		name: j.name,
		seconds: (Date.parse(j.completed_at!) - Date.parse(j.started_at!)) / 1000,
		queueSeconds: Math.max(0, (Date.parse(j.started_at!) - Date.parse(j.created_at)) / 1000),
	}));
	const events = completed
		.flatMap((j) => [
			{ time: Date.parse(j.started_at!), change: 1 },
			{ time: Date.parse(j.completed_at!), change: -1 },
		])
		.sort((a, b) => a.time - b.time || a.change - b.change);
	let active = 0,
		peak = 0;
	for (const event of events) {
		active += event.change;
		peak = Math.max(peak, active);
	}
	return {
		jobCount: completed.length,
		jobMinutes: durations.reduce((sum, j) => sum + j.seconds / 60, 0),
		peakConcurrentJobs: peak,
		lastJob: completed.sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!))[0]
			?.name,
		jobs: durations,
	};
}
export function distribution(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b),
		n = sorted.length;
	return {
		n,
		median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
		p90: n >= 20 ? sorted[Math.ceil(n * 0.9) - 1] : null,
	};
}
