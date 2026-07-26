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

	it('recovers a missing-email recipient while another recipient remains in backoff', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'email-recovered');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'email-recovered',
			recipients: [
				{ userId: 'email-fixed-later' },
				{ userId: 'retrying-user', email: 'retrying@example.test' },
			],
			attemptToken: 'attempt-1',
			now: 2_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'email-recovered',
			attemptToken: 'attempt-1',
			results: [{ userId: 'retrying-user', isSuccess: false, retryAt: 5_000 }],
			now: 2_100,
		});

		const recovered = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'email-recovered',
				recipients: [
					{ userId: 'email-fixed-later', email: 'fixed@example.test' },
					{ userId: 'retrying-user', email: 'retrying@example.test' },
				],
				attemptToken: 'attempt-2',
				now: 3_000,
			}
		);
		expect(recovered?.claims).toEqual([
			{ userId: 'email-fixed-later', email: 'fixed@example.test', attemptCount: 1 },
		]);
		const states = await readAlertState(t);
		expect(states.recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userId: 'email-fixed-later',
					status: 'sending',
				}),
				expect.objectContaining({
					userId: 'retrying-user',
					status: 'pending',
					nextAttemptAt: 5_000,
				}),
			])
		);
		expect(
			states.recipients.find((recipient) => recipient.userId === 'email-fixed-later')
		).not.toHaveProperty('unavailableReason');
	});

	it('keeps six generations of twenty recipients without blocking the current admins', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'recipient-turnover');
		for (let generation = 0; generation < 6; generation += 1) {
			const recipients = Array.from({ length: 20 }, (_, index) => ({
				userId: `generation-${generation}-user-${index}`,
				email: `generation-${generation}-user-${index}@example.test`,
			}));
			const attemptToken = `attempt-${generation}`;
			const prepared = await t.mutation(
				internal.delivery.checklistAlertState.prepareRecipientAttempts,
				{
					organizationId: 'org',
					identity: 'recipient-turnover',
					recipients,
					attemptToken,
					now: 2_000 + generation,
				}
			);
			expect(prepared?.claims).toHaveLength(20);
			if (generation < 5) {
				await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
					organizationId: 'org',
					identity: 'recipient-turnover',
					attemptToken,
					results: recipients.map((recipient) => ({
						userId: recipient.userId,
						isSuccess: false,
						retryAt: 100_000,
					})),
					now: 3_000 + generation,
				});
			}
		}
		const { recipients } = await readAlertState(t);
		expect(recipients).toHaveLength(120);
		expect(recipients.filter((recipient) => recipient.status === 'cancelled')).toHaveLength(100);
		expect(recipients.filter((recipient) => recipient.status === 'sending')).toHaveLength(20);
	});

	it('compacts a non-tail history row by document id without corrupting neighboring states', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'stable-compaction');
		const removedId = await t.run(async (ctx) => {
			const alert = await ctx.db.query('deliverabilityRegressionAlerts').unique();
			if (!alert) throw new Error('missing alert');
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId: alert._id,
				userId: 'protected-first',
				status: 'sent',
				attemptCount: 1,
				sentAt: 10,
			});
			const removedId = await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId: alert._id,
				userId: 'evictable-middle',
				status: 'cancelled',
				attemptCount: 0,
			});
			for (let index = 0; index < 118; index += 1) {
				await ctx.db.insert('deliverabilityAlertRecipients', {
					organizationId: 'org',
					alertId: alert._id,
					userId: `protected-${index}`,
					status: 'sent',
					attemptCount: 1,
					sentAt: 20 + index,
				});
			}
			return removedId;
		});

		await expect(
			t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
				organizationId: 'org',
				identity: 'stable-compaction',
				recipients: [{ userId: 'new-current', email: 'new-current@example.test' }],
				attemptToken: 'new-attempt',
				now: 5_000,
			})
		).resolves.toMatchObject({
			claims: [{ userId: 'new-current', email: 'new-current@example.test', attemptCount: 1 }],
		});
		const { recipients } = await readAlertState(t);
		expect(recipients).toHaveLength(120);
		expect(recipients.some((recipient) => recipient._id === removedId)).toBe(false);
		expect(recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userId: 'protected-first',
					status: 'sent',
					sentAt: 10,
				}),
				expect.objectContaining({
					userId: 'protected-117',
					status: 'sent',
					sentAt: 137,
				}),
				expect.objectContaining({ userId: 'new-current', status: 'sending' }),
			])
		);
	});

	it('admits all 50 current admins alongside 120 protected prior outcomes without duplicates', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'protected-turnover');
		await t.run(async (ctx) => {
			const alert = await ctx.db.query('deliverabilityRegressionAlerts').unique();
			if (!alert) throw new Error('missing alert');
			for (let index = 0; index < 120; index += 1) {
				const protectedState =
					index < 40
						? { status: 'sent' as const, sentAt: index + 1 }
						: index < 80
							? {
									status: 'sending' as const,
									attemptToken: `prior-attempt-${index}`,
									attemptStartedAt: index + 1,
								}
							: {
									status: 'unavailable' as const,
									unavailableReason: 'transport_outcome_unknown' as const,
								};
				await ctx.db.insert('deliverabilityAlertRecipients', {
					organizationId: 'org',
					alertId: alert._id,
					userId: `prior-user-${index}`,
					attemptCount: 1,
					...protectedState,
				});
			}
		});
		const current = Array.from({ length: 50 }, (_, index) => ({
			userId: `current-user-${index}`,
			email: `current-user-${index}@example.test`,
		}));

		const prepared = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'protected-turnover',
				recipients: current,
				attemptToken: 'current-attempt',
				now: 5_000,
			}
		);
		expect(prepared?.claims).toHaveLength(50);

		const repeated = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'protected-turnover',
				recipients: current,
				attemptToken: 'repeated-attempt',
				now: 5_001,
			}
		);
		expect(repeated?.claims).toEqual([]);

		const { recipients } = await readAlertState(t);
		expect(recipients).toHaveLength(170);
		expect(new Set(recipients.map((recipient) => recipient.userId)).size).toBe(170);
		expect(recipients.filter((recipient) => recipient.status === 'sent')).toHaveLength(40);
		expect(recipients.filter((recipient) => recipient.status === 'sending')).toHaveLength(90);
		expect(
			recipients.filter(
				(recipient) =>
					recipient.status === 'unavailable' &&
					recipient.unavailableReason === 'transport_outcome_unknown'
			)
		).toHaveLength(40);
	});

	it('never evicts a sent receipt and does not resend when that admin rejoins at the cap', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'sent-rejoin');
		await t.run(async (ctx) => {
			const alert = await ctx.db.query('deliverabilityRegressionAlerts').unique();
			if (!alert) throw new Error('missing alert');
			for (let index = 0; index < 99; index += 1) {
				await ctx.db.insert('deliverabilityAlertRecipients', {
					organizationId: 'org',
					alertId: alert._id,
					userId: `sent-${index}`,
					status: 'sent',
					attemptCount: 1,
					sentAt: index + 1,
				});
			}
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId: alert._id,
				userId: 'unknown-outcome',
				status: 'unavailable',
				attemptCount: 1,
				unavailableReason: 'transport_outcome_unknown',
			});
			for (let index = 0; index < 20; index += 1) {
				await ctx.db.insert('deliverabilityAlertRecipients', {
					organizationId: 'org',
					alertId: alert._id,
					userId: `old-${index}`,
					status: 'cancelled',
					attemptCount: 0,
				});
			}
		});
		const current = Array.from({ length: 20 }, (_, index) => ({
			userId: `new-${index}`,
			email: `new-${index}@example.test`,
		}));
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'sent-rejoin',
			recipients: current,
			attemptToken: 'new-attempt',
			now: 5_000,
		});
		const rejoined = await t.mutation(
			internal.delivery.checklistAlertState.prepareRecipientAttempts,
			{
				organizationId: 'org',
				identity: 'sent-rejoin',
				recipients: [{ userId: 'sent-0', email: 'sent-0-new@example.test' }],
				attemptToken: 'rejoin-attempt',
				now: 5_001,
			}
		);
		expect(rejoined?.claims).toEqual([]);
		const { recipients } = await readAlertState(t);
		expect(recipients).toHaveLength(120);
		expect(recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userId: 'sent-0',
					status: 'sent',
					attemptCount: 1,
				}),
				expect.objectContaining({
					userId: 'unknown-outcome',
					status: 'unavailable',
					unavailableReason: 'transport_outcome_unknown',
				}),
			])
		);
	});

	it('preserves distinct anonymized ledger rows that share the deleted-account marker', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'anonymized-history');
		const anonymizedIds = await t.run(async (ctx) => {
			const alert = await ctx.db.query('deliverabilityRegressionAlerts').unique();
			if (!alert) throw new Error('missing alert');
			return Promise.all(
				[1, 2].map((sentAt) =>
					ctx.db.insert('deliverabilityAlertRecipients', {
						organizationId: 'org',
						alertId: alert._id,
						userId: '[deleted account]',
						status: 'sent',
						attemptCount: 1,
						sentAt,
					})
				)
			);
		});

		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'anonymized-history',
			recipients: [{ userId: 'current-admin', email: 'current@example.test' }],
			attemptToken: 'current-attempt',
			now: 5_000,
		});

		const { recipients } = await readAlertState(t);
		expect(
			recipients
				.filter((recipient) => anonymizedIds.includes(recipient._id))
				.map((recipient) => recipient.sentAt)
				.sort()
		).toEqual([1, 2]);
	});

	it('clears missing-email reason and retry metadata when an admin departs', async () => {
		const t = convexTest(schema, modules);
		await insertPendingAlert(t, 'missing-email-departed');
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'missing-email-departed',
			recipients: [
				{ userId: 'departed-user' },
				{ userId: 'active-user', email: 'active@example.test' },
			],
			attemptToken: 'attempt-1',
			now: 2_000,
		});
		await t.mutation(internal.delivery.checklistAlertState.completeRecipientAttempts, {
			organizationId: 'org',
			identity: 'missing-email-departed',
			attemptToken: 'attempt-1',
			results: [{ userId: 'active-user', isSuccess: false, retryAt: 5_000 }],
			now: 2_100,
		});
		await t.mutation(internal.delivery.checklistAlertState.prepareRecipientAttempts, {
			organizationId: 'org',
			identity: 'missing-email-departed',
			recipients: [{ userId: 'active-user', email: 'active@example.test' }],
			attemptToken: 'attempt-2',
			now: 3_000,
		});
		const departed = (await readAlertState(t)).recipients.find(
			(recipient) => recipient.userId === 'departed-user'
		);
		expect(departed).toMatchObject({
			status: 'cancelled',
			attemptCount: 0,
		});
		expect(departed).not.toHaveProperty('unavailableReason');
		expect(departed).not.toHaveProperty('attemptToken');
		expect(departed).not.toHaveProperty('attemptStartedAt');
		expect(departed).not.toHaveProperty('nextAttemptAt');
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
