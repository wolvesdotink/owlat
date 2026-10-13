import { expect, it } from 'vitest';
import { distribution, jobMetrics } from '../ci/metrics';
it('distinguishes job count, resource time and peak actual overlap', () => {
	const stamp = (seconds: number) => new Date(seconds * 1000).toISOString();
	const jobs = [
		{
			name: 'a',
			created_at: stamp(0),
			started_at: stamp(10),
			completed_at: stamp(70),
			conclusion: 'success',
		},
		{
			name: 'b',
			created_at: stamp(0),
			started_at: stamp(40),
			completed_at: stamp(100),
			conclusion: 'success',
		},
		{
			name: 'skip',
			created_at: stamp(0),
			started_at: null,
			completed_at: null,
			conclusion: 'skipped',
		},
	];
	expect(jobMetrics(jobs)).toMatchObject({
		jobCount: 2,
		jobMinutes: 2,
		peakConcurrentJobs: 2,
		lastJob: 'b',
	});
	expect(jobMetrics(jobs).jobs[0]?.queueSeconds).toBe(10);
	expect(distribution([1, 3])).toEqual({ n: 2, median: 2, p90: null });
	expect(distribution(Array.from({ length: 20 }, (_, i) => i + 1)).p90).toBe(18);
});
