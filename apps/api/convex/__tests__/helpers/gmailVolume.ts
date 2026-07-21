import { convexTest } from 'convex-test';
import { internal } from '../../_generated/api';

/** Materialize every Gmail volume rollup currently queued by a test. */
export async function refreshPendingGmailVolumes(
	t: ReturnType<typeof convexTest>
): Promise<void> {
	const jobs = await t.run((ctx) => ctx.db.query('gmailDomainVolumeRollupJobs').take(256));
	for (const job of jobs) {
		await t.mutation(internal.delivery.complianceTelemetry.refreshGmailDomainVolume, {
			jobId: job._id,
		});
	}
}
