import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

async function insertPendingAlert(t: ReturnType<typeof convexTest>, identity: string, now = 1_000) {
	await t.run(async (ctx) => {
		const evidence = {
			organizationId: 'org',
			itemId: 'deployment.ptr' as const,
			scopeKind: 'deployment' as const,
			targetKey: '3:org|deployment',
			attemptId: `attempt:${identity}`,
			validator: 'test',
			status: 'pass' as const,
			observedValues: [],
			diagnostic: 'verified',
			observedAt: now,
			createdAt: now,
		};
		const previousEvidenceId = await ctx.db.insert('deliverabilityEvidence', evidence);
		const regressedEvidenceId = await ctx.db.insert('deliverabilityEvidence', {
			...evidence,
			attemptId: `regressed:${identity}`,
			status: 'fail',
		});
		await ctx.db.insert('deliverabilityRegressionAlerts', {
			organizationId: 'org',
			identity,
			itemId: 'deployment.ptr',
			targetKey: '3:org|deployment',
			previousEvidenceId,
			regressedEvidenceId,
			observedAt: now,
			message: 'PTR regressed',
			emailNotificationState: 'pending',
			createdAt: now,
		});
	});
}

async function readAlertState(t: ReturnType<typeof convexTest>) {
	return t.run(async (ctx) => ({
		alert: await ctx.db.query('deliverabilityRegressionAlerts').unique(),
		recipients: await ctx.db.query('deliverabilityAlertRecipients').collect(),
	}));
}

describe('deliverability regression email state', () => {
	it('does not return a recovered alert to a delayed email retry', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			const evidence = {
				organizationId: 'org',
				itemId: 'deployment.ptr' as const,
				scopeKind: 'deployment' as const,
				targetKey: '3:org|deployment',
				attemptId: 'attempt',
				validator: 'test',
				status: 'pass' as const,
				observedValues: [],
				diagnostic: 'verified',
				observedAt: now,
				createdAt: now,
			};
			const previousEvidenceId = await ctx.db.insert('deliverabilityEvidence', evidence);
			const regressedEvidenceId = await ctx.db.insert('deliverabilityEvidence', {
				...evidence,
				attemptId: 'regressed',
				status: 'fail',
			});
			await ctx.db.insert('deliverabilityRegressionAlerts', {
				organizationId: 'org',
				identity: 'incident',
				itemId: 'deployment.ptr',
				targetKey: '3:org|deployment',
				previousEvidenceId,
				regressedEvidenceId,
				observedAt: now,
				message: 'PTR regressed',
				emailNotificationState: 'pending',
				resolvedAt: now,
				createdAt: now,
			});
		});
		await expect(
			t.query(internal.delivery.checklistAlertState.getPending, {
				organizationId: 'org',
				identity: 'incident',
			})
		).resolves.toBeNull();
	});

	it('persists success by user id and retries only the failed user at their current email', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'partial');

		const first = await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'partial',
			recipients: [
				{ userId: 'user-a', email: 'old-a@example.test' },
				{ userId: 'user-b', email: 'old-b@example.test' },
			],
			attemptToken: 'attempt-1',
			now: 2_000,
		});
		expect(first?.claims).toEqual([
			{ userId: 'user-a', email: 'old-a@example.test', attemptCount: 1 },
			{ userId: 'user-b', email: 'old-b@example.test', attemptCount: 1 },
		]);
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'partial',
			attemptToken: 'attempt-1',
			results: [
				{ userId: 'user-a', isSuccess: true },
				{ userId: 'user-b', isSuccess: false, retryAt: 3_000 },
			],
			now: 2_100,
		});

		const retry = await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'partial',
			recipients: [
				{ userId: 'user-a', email: 'new-a@example.test' },
				{ userId: 'user-b', email: 'new-b@example.test' },
			],
			attemptToken: 'attempt-2',
			now: 3_000,
		});
		expect(retry?.claims).toEqual([
			{ userId: 'user-b', email: 'new-b@example.test', attemptCount: 2 },
		]);
		await expect(
			t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
				organizationId: 'org',
				identity: 'partial',
				attemptToken: 'attempt-2',
				results: [{ userId: 'user-b', isSuccess: true }],
				now: 3_100,
			})
		).resolves.toMatchObject({ state: 'sent', retryScheduled: false });
		await expect(readAlertState(t)).resolves.toMatchObject({
			alert: {
				emailNotificationState: 'sent',
				emailNotifiedAt: 2_100,
			},
			recipients: [
				expect.objectContaining({ userId: 'user-a', status: 'sent', attemptCount: 1 }),
				expect.objectContaining({ userId: 'user-b', status: 'sent', attemptCount: 2 }),
			],
		});
	});

	it('cancels a departed failed admin without duplicating the successful admin', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'departure');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'departure',
			recipients: [
				{ userId: 'sent-user', email: 'sent@example.test' },
				{ userId: 'departed-user', email: 'departed@example.test' },
			],
			attemptToken: 'attempt-1',
			now: 2_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'departure',
			attemptToken: 'attempt-1',
			results: [
				{ userId: 'sent-user', isSuccess: true },
				{ userId: 'departed-user', isSuccess: false, retryAt: 3_000 },
			],
			now: 2_100,
		});

		await expect(
			t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
				organizationId: 'org',
				identity: 'departure',
				recipients: [{ userId: 'sent-user', email: 'changed@example.test' }],
				attemptToken: 'attempt-2',
				now: 3_000,
			})
		).resolves.toMatchObject({ claims: [], state: 'sent' });
		await expect(readAlertState(t)).resolves.toMatchObject({
			alert: {
				emailNotificationState: 'sent',
				emailNotifiedAt: 2_100,
			},
			recipients: [
				expect.objectContaining({ userId: 'sent-user', status: 'sent' }),
				expect.objectContaining({ userId: 'departed-user', status: 'cancelled' }),
			],
		});
	});

	it('never re-drives a live or ambiguous external-send boundary', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'ambiguous');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'ambiguous',
			recipients: [{ userId: 'user-a', email: 'a@example.test' }],
			attemptToken: 'attempt-1',
			now: 2_000,
		});

		await expect(
			t.mutation(internal.delivery.checklistAlertState.expireRecipientAttempts, {
				organizationId: 'org',
				identity: 'ambiguous',
				attemptToken: 'unrelated-attempt',
			})
		).resolves.toMatchObject({ expired: 0, state: 'pending' });
		await expect(
			t.mutation(internal.delivery.checklistAlertState.expireRecipientAttempts, {
				organizationId: 'org',
				identity: 'ambiguous',
				attemptToken: 'attempt-1',
			})
		).resolves.toMatchObject({ expired: 1, state: 'unavailable' });
		await expect(readAlertState(t)).resolves.toMatchObject({
			alert: { emailNotificationState: 'unavailable' },
			recipients: [
				expect.objectContaining({
					userId: 'user-a',
					status: 'unavailable',
					unavailableReason: 'transport_outcome_unknown',
				}),
			],
		});
	});

	it('does not let stale watchdog jobs collapse a recipient backoff', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'interleaved-watchdogs');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'interleaved-watchdogs',
			recipients: [{ userId: 'user-a', email: 'a@example.test' }],
			attemptToken: 'attempt-1',
			now: 1_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'interleaved-watchdogs',
			attemptToken: 'attempt-1',
			results: [{ userId: 'user-a', isSuccess: false, retryAt: 61_000 }],
			now: 1_100,
		});
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'interleaved-watchdogs',
			recipients: [{ userId: 'user-a', email: 'a@example.test' }],
			attemptToken: 'attempt-2',
			now: 61_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'interleaved-watchdogs',
			attemptToken: 'attempt-2',
			results: [{ userId: 'user-a', isSuccess: false, retryAt: 361_000 }],
			now: 61_100,
		});

		await expect(
			t.mutation(internal.delivery.checklistAlertState.expireRecipientAttempts, {
				organizationId: 'org',
				identity: 'interleaved-watchdogs',
				attemptToken: 'attempt-1',
			})
		).resolves.toMatchObject({ expired: 0, state: 'pending' });
		const dueRetry = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'interleaved-watchdogs',
				recipients: [{ userId: 'user-a', email: 'a@example.test' }],
				attemptToken: 'attempt-3',
				now: 361_000,
			}
		);
		expect(dueRetry?.claims).toEqual([
			{ userId: 'user-a', email: 'a@example.test', attemptCount: 3 },
		]);
		await expect(
			t.mutation(internal.delivery.checklistAlertState.expireRecipientAttempts, {
				organizationId: 'org',
				identity: 'interleaved-watchdogs',
				attemptToken: 'attempt-2',
			})
		).resolves.toMatchObject({ expired: 0, state: 'pending' });
	});

	it('keeps the earliest due retry across mixed recipient attempt counts', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'mixed-attempts');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'mixed-attempts',
			recipients: [{ userId: 'user-a', email: 'a@example.test' }],
			attemptToken: 'attempt-a-1',
			now: 1_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'mixed-attempts',
			attemptToken: 'attempt-a-1',
			results: [{ userId: 'user-a', isSuccess: false, retryAt: 301_000 }],
			now: 1_100,
		});
		const newAdminAttempt = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'mixed-attempts',
				recipients: [
					{ userId: 'user-a', email: 'a@example.test' },
					{ userId: 'user-b', email: 'b@example.test' },
				],
				attemptToken: 'attempt-b-1',
				now: 61_000,
			}
		);
		expect(newAdminAttempt?.claims).toEqual([
			{ userId: 'user-b', email: 'b@example.test', attemptCount: 1 },
		]);
		await expect(
			t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
				organizationId: 'org',
				identity: 'mixed-attempts',
				attemptToken: 'attempt-b-1',
				results: [{ userId: 'user-b', isSuccess: false, retryAt: 121_000 }],
				now: 61_100,
			})
		).resolves.toMatchObject({ state: 'pending', retryScheduled: true });
		const firstRetryState = await readAlertState(t);
		expect(firstRetryState.recipients).toEqual([
			expect.objectContaining({ userId: 'user-a', nextAttemptAt: 301_000 }),
			expect.objectContaining({ userId: 'user-b', nextAttemptAt: 121_000 }),
		]);
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(scheduled.some((job) => job.scheduledTime === 121_000)).toBe(true);

		const secondAdminAttempt = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'mixed-attempts',
				recipients: [
					{ userId: 'user-a', email: 'a@example.test' },
					{ userId: 'user-b', email: 'b@example.test' },
				],
				attemptToken: 'attempt-b-2',
				now: 121_000,
			}
		);
		expect(secondAdminAttempt?.claims).toEqual([
			{ userId: 'user-b', email: 'b@example.test', attemptCount: 2 },
		]);
		await expect(
			t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
				organizationId: 'org',
				identity: 'mixed-attempts',
				attemptToken: 'attempt-b-2',
				results: [{ userId: 'user-b', isSuccess: true }],
				now: 121_100,
			})
		).resolves.toMatchObject({ state: 'pending', retryScheduled: true });
		const scheduledAfterSuccess = await t.run((ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduledAfterSuccess.some((job) => job.scheduledTime === 301_000)).toBe(true);
	});

	it('does not report sent when every eligible admin is unavailable', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'missing-email');
		await expect(
			t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
				organizationId: 'org',
				identity: 'missing-email',
				recipients: [{ userId: 'user-a' }],
				attemptToken: 'attempt-1',
				now: 2_000,
			})
		).resolves.toMatchObject({ claims: [], state: 'unavailable' });
		const alert = await t.run((ctx) => ctx.db.query('deliverabilityRegressionAlerts').unique());
		expect(alert).toMatchObject({ emailNotificationState: 'unavailable' });
		expect(alert).not.toHaveProperty('emailNotifiedAt');
	});

	it('closes exhausted directory recovery honestly while retaining a prior success', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'directory-exhausted');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'directory-exhausted',
			recipients: [
				{ userId: 'sent-user', email: 'sent@example.test' },
				{ userId: 'pending-user', email: 'pending@example.test' },
			],
			attemptToken: 'attempt-1',
			now: 2_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'directory-exhausted',
			attemptToken: 'attempt-1',
			results: [
				{ userId: 'sent-user', isSuccess: true },
				{ userId: 'pending-user', isSuccess: false, retryAt: 3_000 },
			],
			now: 2_100,
		});

		await expect(
			t.mutation(internal.delivery.checklistAlertState.deferRecipientDirectory, {
				organizationId: 'org',
				identity: 'directory-exhausted',
				now: 3_000,
			})
		).resolves.toEqual({ state: 'sent', retryScheduled: false });
		await expect(readAlertState(t)).resolves.toMatchObject({
			alert: {
				emailNotificationState: 'sent',
				emailNotifiedAt: 2_100,
			},
			recipients: [
				expect.objectContaining({ userId: 'sent-user', status: 'sent' }),
				expect.objectContaining({
					userId: 'pending-user',
					status: 'unavailable',
					unavailableReason: 'recipient_directory_unavailable',
				}),
			],
		});
	});
});
