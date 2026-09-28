/**
 * Form-submission metadata scrub: the continuation reads the same range as the
 * first batch.
 *
 * Convex rejects a pagination cursor whose query (index range included)
 * differs from the one that minted it. The scrub's range is
 * `_creationTime < now - 90d`, so each continuation must carry the first
 * batch's clock, not read a fresh one. convex-test does not check the cursor
 * fingerprint, so this pins the argument that keeps it stable.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

// Same glob arrangement as agentMetricsRetention.test.ts.
const rootGlob = import.meta.glob('../../**/*.*s');
const maintenanceGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../maintenance/'),
		mod,
	])
);
const modules = { ...rootGlob, ...maintenanceGlob };

const DAY_MS = 24 * 60 * 60 * 1000;
/** BATCH in maintenance/retention.ts. */
const BATCH = 200;

afterEach(() => {
	vi.useRealTimers();
});

describe('scrubFormSubmissionMeta', () => {
	it('pins its start time into the continuation and drains the backlog', async () => {
		vi.useFakeTimers();
		const startedAt = Date.now();
		const t = convexTest(schema, modules);

		// `_creationTime` is the insert clock, so seed the backlog 100 days back.
		vi.setSystemTime(startedAt - 100 * DAY_MS);
		await t.run(async (ctx) => {
			const formEndpointId = await ctx.db.insert('formEndpoints', {
				name: 'Signup',
				fields: [],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (let i = 0; i < BATCH + 1; i++) {
				await ctx.db.insert('formSubmissions', {
					formEndpointId,
					data: {},
					status: 'success',
					ipAddress: '192.0.2.1',
					userAgent: 'test',
					submittedAt: Date.now(),
				});
			}
		});
		vi.setSystemTime(startedAt);

		await t.mutation(internal.maintenance.retention.scrubFormSubmissionMeta, {});

		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]!.args[0]).toMatchObject({ startedAt });

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const rows = await t.run(async (ctx) => ctx.db.query('formSubmissions').collect());
		expect(rows.every((row) => row.ipAddress === undefined && row.userAgent === undefined)).toBe(
			true
		);
	});
});
