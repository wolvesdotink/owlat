import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION } from '../../lib/constants';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };
const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;

describe('Deliverability Center regression evidence', () => {
	it('preserves an active propagation generation when an hourly sweep arrives first', async () => {
		const t = convexTest(schema, modules);
		const organizationId = 'org-hourly';
		const targetKey = `${organizationId.length}:${organizationId}|deployment`;
		const stateId = await t.run((ctx) =>
			ctx.db.insert('deliverabilityVerificationState', {
				organizationId,
				itemId: 'deployment.ptr',
				targetKey,
				attemptId: 'retry-attempt',
				generation: 7,
				retryIndex: 4,
				nextCheckAt: 81_000,
				leaseToken: 'retry-lease',
				leaseExpiresAt: 21_000,
				updatedAt: 21_000,
			})
		);

		await expect(
			t.mutation(internal.delivery.checklistEvidence.claimVerification, {
				organizationId,
				itemId: 'deployment.ptr',
				attemptId: 'hourly-sweep',
				leaseToken: 'sweep-lease',
				now: 60_000,
				preserveScheduledRetry: true,
			})
		).resolves.toEqual({
			claimed: false,
			reason: 'scheduled_retry',
			nextCheckAt: 81_000,
		});
		await expect(t.run((ctx) => ctx.db.get(stateId))).resolves.toMatchObject({
			attemptId: 'retry-attempt',
			generation: 7,
			retryIndex: 4,
			nextCheckAt: 81_000,
		});
	});

	it('reclaims a lost scheduled retry after the bounded scheduler grace', async () => {
		const t = convexTest(schema, modules);
		const organizationId = 'org-lost-retry';
		const targetKey = `${organizationId.length}:${organizationId}|deployment`;
		await t.run((ctx) =>
			ctx.db.insert('deliverabilityVerificationState', {
				organizationId,
				itemId: 'deployment.ptr',
				targetKey,
				attemptId: 'lost-retry-attempt',
				generation: 7,
				retryIndex: 3,
				nextCheckAt: 81_000,
				leaseToken: 'lost-retry-lease',
				leaseExpiresAt: 21_000,
				updatedAt: 21_000,
			})
		);

		await expect(
			t.mutation(internal.delivery.checklistEvidence.claimVerification, {
				organizationId,
				itemId: 'deployment.ptr',
				attemptId: 'recovery-sweep',
				leaseToken: 'recovery-lease',
				now: 141_001,
				preserveScheduledRetry: true,
			})
		).resolves.toMatchObject({
			claimed: true,
			generation: 8,
			retryIndex: 0,
		});
	});

	it('lets the scheduled retry claim exactly at its due time', async () => {
		const t = convexTest(schema, modules);
		const organizationId = 'org-scheduler-edge';
		const targetKey = `${organizationId.length}:${organizationId}|deployment`;
		await t.run((ctx) =>
			ctx.db.insert('deliverabilityVerificationState', {
				organizationId,
				itemId: 'deployment.ptr',
				targetKey,
				attemptId: 'scheduled-attempt',
				generation: 7,
				retryIndex: 3,
				nextCheckAt: 81_000,
				leaseToken: 'scheduled-lease',
				leaseExpiresAt: 21_000,
				updatedAt: 21_000,
			})
		);

		await expect(
			t.mutation(internal.delivery.checklistEvidence.claimVerification, {
				organizationId,
				itemId: 'deployment.ptr',
				attemptId: 'due-retry-attempt',
				leaseToken: 'due-retry-lease',
				now: 81_000,
				expectedGeneration: 7,
			})
		).resolves.toMatchObject({
			claimed: true,
			generation: 7,
			retryIndex: 3,
		});
	});

	it('alerts pass → transient warn → confirmed fail and resolves on recovery', async () => {
		const t = convexTest(schema, modules);
		const organizationId = 'org-regression';
		const record = async (
			attemptId: string,
			status: 'pass' | 'warn' | 'fail',
			validator: string,
			observedAt: number
		) => {
			const leaseToken = `lease:${attemptId}`;
			const claim = await t.mutation(internal.delivery.checklistEvidence.claimVerification, {
				organizationId,
				itemId: 'deployment.ptr',
				attemptId,
				leaseToken,
				now: observedAt,
			});
			if (!claim.claimed) throw new Error('claim failed');
			return t.mutation(internal.delivery.checklistEvidence.recordEvidence, {
				organizationId,
				itemId: 'deployment.ptr',
				attemptId,
				generation: claim.generation,
				leaseToken,
				validator,
				status,
				observedValues: [],
				diagnostic: status === 'fail' ? 'PTR lookup no longer returns a hostname.' : status,
				observedAt,
			});
		};
		await record('pass', 'pass', 'mta.fcrdns', 1_000);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('deliverabilityEvidence')
					.withIndex('by_org_attempt', (q) =>
						q.eq('organizationId', organizationId).eq('attemptId', 'pass')
					)
					.unique()
			)
		).toMatchObject({
			observedValuesVersion: CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION,
		});
		await record('transient', 'warn', 'checklist.orchestrator', 2_000);
		await record('fail', 'fail', 'mta.fcrdns', 3_000);
		const alert = await t.run((ctx) => ctx.db.query('deliverabilityRegressionAlerts').unique());
		expect(alert?.message).toContain('Prove you own your server');
		expect(alert?.message).not.toContain('deployment.ptr');
		expect(alert?.resolvedAt).toBeUndefined();
		if (!alert) throw new Error('alert was not created');
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId,
				alertId: alert._id,
				userId: 'pending-user',
				status: 'pending',
				attemptCount: 1,
				nextAttemptAt: 9_000,
			});
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId,
				alertId: alert._id,
				userId: 'sending-user',
				status: 'sending',
				attemptCount: 1,
				attemptToken: 'in-flight',
				attemptStartedAt: 3_500,
			});
		});
		await record('recovered', 'pass', 'mta.fcrdns', 4_000);
		const recovered = await t.run(async (ctx) => ({
			alert: await ctx.db.query('deliverabilityRegressionAlerts').unique(),
			recipients: await ctx.db.query('deliverabilityAlertRecipients').collect(),
		}));
		expect(recovered.alert).toMatchObject({
			resolvedAt: 4_000,
			emailNotificationState: 'pending',
		});
		expect(recovered.recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userId: 'pending-user',
					status: 'cancelled',
				}),
				expect.objectContaining({
					userId: 'sending-user',
					status: 'sending',
					attemptToken: 'in-flight',
				}),
			])
		);
		expect(
			recovered.recipients.find((recipient) => recipient.userId === 'pending-user')
		).not.toHaveProperty('nextAttemptAt');
		await expect(
			t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
				organizationId,
				identity: alert.identity,
				attemptToken: 'in-flight',
				results: [{ userId: 'sending-user', isSuccess: true }],
				now: 4_100,
			})
		).resolves.toEqual({ state: 'sent', retryScheduled: false });
	});

	describe('IPv6 checks', () => {
		const IPV6 = '2001:db8::10';
		const warmingIp = (ip: string) => ({
			ip,
			phase: 'graduated',
			currentDay: 30,
			dailyCap: 1_000,
			sentToday: 0,
			bounceRate: 0,
			deferralRate: 0,
			pool: 'campaign',
			active: true,
		});
		const snapshot = (ips: string[], syncedAt: number) => ({
			phase: 'graduated',
			totalDailyCap: 1_000,
			totalSentToday: 0,
			ipCount: ips.length,
			ips: ips.map(warmingIp),
			syncedAt,
		});

		function recorder(t: TestConvex, organizationId: string) {
			return async (attemptId: string, status: 'pass' | 'warn' | 'fail', observedAt: number) => {
				const leaseToken = `lease:${attemptId}`;
				const claim = await t.mutation(internal.delivery.checklistEvidence.claimVerification, {
					organizationId,
					itemId: 'deployment.ipv6_ptr',
					attemptId,
					leaseToken,
					now: observedAt,
				});
				if (!claim.claimed) throw new Error('claim failed');
				return t.mutation(internal.delivery.checklistEvidence.recordEvidence, {
					organizationId,
					itemId: 'deployment.ipv6_ptr',
					attemptId,
					generation: claim.generation,
					leaseToken,
					validator: 'mta.ipv6-fcrdns',
					status,
					observedValues: [],
					diagnostic: status,
					observedAt,
				});
			};
		}

		const openAlerts = (t: TestConvex) =>
			t.run((ctx) =>
				ctx.db
					.query('deliverabilityRegressionAlerts')
					.withIndex('by_resolved_at', (q) => q.eq('resolvedAt', undefined))
					.collect()
			);

		it('alerts on a regression while IPv6 is on', async () => {
			const t = convexTest(schema, modules);
			const record = recorder(t, 'org-ipv6-on');
			await t.mutation(
				internal.delivery.warmingSync.upsertWarmingState,
				snapshot(['203.0.113.10', IPV6], 500)
			);
			await record('pass', 'pass', 1_000);
			await record('fail', 'fail', 2_000);
			expect(await openAlerts(t)).toHaveLength(1);
		});

		it('raises no alert (and schedules no email) once IPv6 is off', async () => {
			const t = convexTest(schema, modules);
			const record = recorder(t, 'org-ipv6-off');
			await t.mutation(
				internal.delivery.warmingSync.upsertWarmingState,
				snapshot(['203.0.113.10', IPV6], 500)
			);
			await record('pass', 'pass', 1_000);
			// The operator removes the IPv6 address from the pools.
			await t.mutation(
				internal.delivery.warmingSync.upsertWarmingState,
				snapshot(['203.0.113.10'], 1_500)
			);
			await record('warn', 'warn', 2_000);
			expect(
				await t.run((ctx) => ctx.db.query('deliverabilityRegressionAlerts').collect())
			).toEqual([]);
			const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
			expect(scheduled.map((job) => job.name)).not.toContainEqual(
				expect.stringContaining('deliverRegressionEmail')
			);
		});

		it('resolves open IPv6 alerts when the warming sync learns IPv6 is off', async () => {
			const t = convexTest(schema, modules);
			const organizationId = 'org-ipv6-disabled';
			const record = recorder(t, organizationId);
			await t.mutation(
				internal.delivery.warmingSync.upsertWarmingState,
				snapshot(['203.0.113.10', IPV6], 500)
			);
			await record('pass', 'pass', 1_000);
			await record('fail', 'fail', 2_000);
			const [alert] = await openAlerts(t);
			if (!alert) throw new Error('alert was not created');
			await t.run((ctx) =>
				ctx.db.insert('deliverabilityAlertRecipients', {
					organizationId,
					alertId: alert._id,
					userId: 'pending-user',
					status: 'pending',
					attemptCount: 1,
					nextAttemptAt: 9_000,
				})
			);

			// A sync that still reports IPv6 leaves the alert open.
			await t.mutation(internal.delivery.warmingSync.upsertWarmingState, {
				...snapshot(['203.0.113.10', IPV6], 2_500),
				organizationId,
			});
			expect(await openAlerts(t)).toHaveLength(1);

			await t.mutation(internal.delivery.warmingSync.upsertWarmingState, {
				...snapshot(['203.0.113.10'], 3_000),
				organizationId,
			});
			expect(await openAlerts(t)).toEqual([]);
			await expect(t.run((ctx) => ctx.db.get(alert._id))).resolves.toMatchObject({
				resolvedAt: 3_000,
			});
			await expect(
				t.query(internal.delivery.checklistAlertState.getPending, {
					identity: alert.identity,
					organizationId,
				})
			).resolves.toBeNull();
			const [recipient] = await t.run((ctx) =>
				ctx.db.query('deliverabilityAlertRecipients').collect()
			);
			expect(recipient?.status).toBe('cancelled');
		});

		it('also closes an IPv6 alert on the next check when IPv6 is already off', async () => {
			const t = convexTest(schema, modules);
			const organizationId = 'org-ipv6-stale-alert';
			const record = recorder(t, organizationId);
			await t.mutation(
				internal.delivery.warmingSync.upsertWarmingState,
				snapshot(['203.0.113.10', IPV6], 500)
			);
			await record('pass', 'pass', 1_000);
			await record('fail', 'fail', 2_000);
			// IPv6 off, but the sync ran without an organization to scope clean-up.
			await t.mutation(
				internal.delivery.warmingSync.upsertWarmingState,
				snapshot(['203.0.113.10'], 2_500)
			);
			expect(await openAlerts(t)).toHaveLength(1);
			await record('after-off', 'warn', 3_000);
			expect(await openAlerts(t)).toEqual([]);
		});
	});
});
