import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import {
	DELIVERABILITY_COMPLETED_RETENTION_MS,
	DELIVERABILITY_EVIDENCE_RETENTION_MS,
	DELIVERABILITY_ALERT_RETENTION_BATCH_SIZE,
	DELIVERABILITY_RETENTION_BATCH_SIZE,
} from '../checklistRetention';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const ORGANIZATION_ID = 'org-retention';
const TARGET_KEY = `${ORGANIZATION_ID.length}:${ORGANIZATION_ID}|deployment`;

afterEach(() => vi.useRealTimers());

function evidenceValues(observedAt: number, attemptId: string) {
	return {
		organizationId: ORGANIZATION_ID,
		itemId: 'deployment.ptr' as const,
		scopeKind: 'deployment' as const,
		targetKey: TARGET_KEY,
		attemptId,
		validator: 'retention-test',
		status: 'pass' as const,
		observedValues: ['203.0.113.10'],
		diagnostic: 'test observation',
		observedAt,
		createdAt: observedAt,
	};
}

async function insertAlert(
	t: ReturnType<typeof convexTest>,
	args: {
		identity: string;
		previousEvidenceId: Id<'deliverabilityEvidence'>;
		regressedEvidenceId: Id<'deliverabilityEvidence'>;
		observedAt: number;
		resolvedAt?: number;
		domainId?: Id<'domains'>;
	}
) {
	return t.run((ctx) =>
		ctx.db.insert('deliverabilityRegressionAlerts', {
			organizationId: ORGANIZATION_ID,
			identity: args.identity,
			itemId: 'deployment.ptr',
			targetKey: TARGET_KEY,
			...(args.domainId ? { domainId: args.domainId } : {}),
			previousEvidenceId: args.previousEvidenceId,
			regressedEvidenceId: args.regressedEvidenceId,
			observedAt: args.observedAt,
			message: 'PTR regressed',
			emailNotificationState: 'sent',
			...(args.resolvedAt === undefined ? {} : { resolvedAt: args.resolvedAt }),
			createdAt: args.observedAt,
		})
	);
}

describe('Deliverability Center retention', () => {
	it('resolves active alerts after their domain is deleted', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const [domainId, previousEvidenceId, regressedEvidenceId] = await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', {
				domain: 'deleted.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
			return [
				domainId,
				await ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'previous-deleted')),
				await ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'regressed-deleted')),
			] as const;
		});
		const alertId = await insertAlert(t, {
			identity: 'deleted-domain',
			previousEvidenceId,
			regressedEvidenceId,
			observedAt: now,
			domainId,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: ORGANIZATION_ID,
				alertId,
				userId: 'pending-user',
				status: 'pending',
				attemptCount: 0,
				nextAttemptAt: now + 1_000,
			});
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: ORGANIZATION_ID,
				alertId,
				userId: 'sending-user',
				status: 'sending',
				attemptCount: 1,
				attemptToken: 'in-flight',
				attemptStartedAt: now - 100,
			});
			await ctx.db.delete(domainId);
		});
		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepOrphanAlerts, { startedAt: now })
		).resolves.toMatchObject({ resolved: 1 });
		const state = await t.run(async (ctx) => ({
			alert: await ctx.db.query('deliverabilityRegressionAlerts').unique(),
			recipients: await ctx.db.query('deliverabilityAlertRecipients').collect(),
		}));
		expect(state.alert).toMatchObject({
			resolvedAt: now,
			emailNotificationState: 'pending',
		});
		expect(state.recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ userId: 'pending-user', status: 'cancelled' }),
				expect.objectContaining({
					userId: 'sending-user',
					status: 'sending',
					attemptToken: 'in-flight',
				}),
			])
		);
		await expect(
			t.mutation(internal.delivery.checklistAlertState.expireRecipientAttempts, {
				organizationId: ORGANIZATION_ID,
				identity: 'deleted-domain',
				attemptToken: 'in-flight',
			})
		).resolves.toEqual({ state: 'unavailable', expired: 1 });
	});

	it('boundedly removes deleted-domain state before releasing its old current evidence', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_EVIDENCE_RETENTION_MS - 1;
		await t.run(async (ctx) => {
			for (let index = 0; index < DELIVERABILITY_RETENTION_BATCH_SIZE + 2; index++) {
				const domainId = await ctx.db.insert('domains', {
					domain: `orphan-${index}.example`,
					status: 'verified',
					dnsRecords: {},
					createdAt: now,
					updatedAt: now,
				});
				const targetKey = `${ORGANIZATION_ID.length}:${ORGANIZATION_ID}|domain:${domainId}`;
				const currentEvidenceId =
					index === 0
						? await ctx.db.insert('deliverabilityEvidence', {
								...evidenceValues(old, 'orphan-current'),
								itemId: 'domain.spf',
								scopeKind: 'domain',
								targetKey,
								domainId,
							})
						: undefined;
				await ctx.db.insert('deliverabilityVerificationState', {
					organizationId: ORGANIZATION_ID,
					itemId: 'domain.spf',
					targetKey,
					domainId,
					attemptId: `orphan-${index}`,
					generation: 1,
					retryIndex: 0,
					leaseToken: `lease-${index}`,
					leaseExpiresAt: 0,
					...(currentEvidenceId === undefined ? {} : { currentEvidenceId }),
					updatedAt: now,
				});
				await ctx.db.delete(domainId);
			}
		});

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepOrphanVerificationStates, {
				startedAt: now,
			})
		).resolves.toEqual({
			examined: DELIVERABILITY_RETENTION_BATCH_SIZE,
			deleted: DELIVERABILITY_RETENTION_BATCH_SIZE,
			continuationScheduled: true,
		});
		expect(
			await t.run(
				async (ctx) => (await ctx.db.query('deliverabilityVerificationState').collect()).length
			)
		).toBe(2);

		await t.finishAllScheduledFunctions(() => vi.runAllTimers());
		await expect(
			t.run(async (ctx) => ({
				stateCount: (await ctx.db.query('deliverabilityVerificationState').collect()).length,
				evidenceCount: (await ctx.db.query('deliverabilityEvidence').collect()).length,
			}))
		).resolves.toEqual({ stateCount: 0, evidenceCount: 0 });
	});

	it('deletes only old superseded evidence and preserves every active reference', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_EVIDENCE_RETENTION_MS - 1;
		const [supersededId, currentId, previousId, regressedId, recentId] = await t.run(
			async (ctx) => {
				const ids = await Promise.all([
					ctx.db.insert('deliverabilityEvidence', evidenceValues(old, 'superseded')),
					ctx.db.insert('deliverabilityEvidence', evidenceValues(old, 'current')),
					ctx.db.insert('deliverabilityEvidence', evidenceValues(old, 'previous')),
					ctx.db.insert('deliverabilityEvidence', evidenceValues(old, 'regressed')),
					ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'recent')),
				]);
				await ctx.db.insert('deliverabilityVerificationState', {
					organizationId: ORGANIZATION_ID,
					itemId: 'deployment.ptr',
					targetKey: TARGET_KEY,
					attemptId: 'current',
					generation: 1,
					retryIndex: 0,
					leaseToken: 'lease',
					leaseExpiresAt: 0,
					currentEvidenceId: ids[1],
					updatedAt: now,
				});
				return ids;
			}
		);
		await insertAlert(t, {
			identity: 'unresolved',
			previousEvidenceId: previousId,
			regressedEvidenceId: regressedId,
			observedAt: old,
		});

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepEvidence, { startedAt: now })
		).resolves.toMatchObject({ examined: 4, deleted: 1 });

		const remainingIds = await t.run(async (ctx) =>
			(await ctx.db.query('deliverabilityEvidence').collect()).map((row) => row._id)
		);
		expect(remainingIds).not.toContain(supersededId);
		expect(remainingIds).toEqual(
			expect.arrayContaining([currentId, previousId, regressedId, recentId])
		);
	});

	it('deletes old resolved alerts while retaining unresolved and recent incidents', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_COMPLETED_RETENTION_MS - 1;
		const [previousEvidenceId, regressedEvidenceId] = await t.run(async (ctx) => [
			await ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'previous')),
			await ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'regressed')),
		]);
		const staleResolvedId = await insertAlert(t, {
			identity: 'stale-resolved',
			previousEvidenceId,
			regressedEvidenceId,
			observedAt: old,
			resolvedAt: old,
		});
		const unresolvedId = await insertAlert(t, {
			identity: 'unresolved',
			previousEvidenceId,
			regressedEvidenceId,
			observedAt: old,
		});
		const recentResolvedId = await insertAlert(t, {
			identity: 'recent-resolved',
			previousEvidenceId,
			regressedEvidenceId,
			observedAt: now,
			resolvedAt: now,
		});

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepAlerts, { startedAt: now })
		).resolves.toMatchObject({ examined: 1, deleted: 1 });

		const remainingIds = await t.run(async (ctx) =>
			(await ctx.db.query('deliverabilityRegressionAlerts').collect()).map((row) => row._id)
		);
		expect(remainingIds).not.toContain(staleResolvedId);
		expect(remainingIds).toEqual(expect.arrayContaining([unresolvedId, recentResolvedId]));
	});

	it('boundedly deletes full recipient histories before their parent alerts', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_COMPLETED_RETENTION_MS - 10;
		const [previousEvidenceId, regressedEvidenceId] = await t.run(async (ctx) => [
			await ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'parent-page-previous')),
			await ctx.db.insert('deliverabilityEvidence', evidenceValues(now, 'parent-page-regressed')),
		]);
		await t.run(async (ctx) => {
			for (
				let alertIndex = 0;
				alertIndex < DELIVERABILITY_ALERT_RETENTION_BATCH_SIZE + 1;
				alertIndex++
			) {
				const alertId = await ctx.db.insert('deliverabilityRegressionAlerts', {
					organizationId: ORGANIZATION_ID,
					identity: `recipient-history-${alertIndex}`,
					itemId: 'deployment.ptr',
					targetKey: TARGET_KEY,
					previousEvidenceId,
					regressedEvidenceId,
					observedAt: old + alertIndex,
					message: 'PTR regressed',
					emailNotificationState: 'sent',
					emailNotifiedAt: old + alertIndex,
					resolvedAt: old + alertIndex,
					createdAt: old + alertIndex,
				});
				const recipientCount = alertIndex === 0 ? 100 : 1;
				for (let recipientIndex = 0; recipientIndex < recipientCount; recipientIndex++) {
					await ctx.db.insert('deliverabilityAlertRecipients', {
						organizationId: ORGANIZATION_ID,
						alertId,
						userId: `user-${alertIndex}-${recipientIndex}`,
						status: 'sent',
						attemptCount: 1,
						sentAt: old + alertIndex,
					});
				}
			}
		});

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepAlerts, { startedAt: now })
		).resolves.toEqual({
			examined: DELIVERABILITY_ALERT_RETENTION_BATCH_SIZE,
			deleted: DELIVERABILITY_ALERT_RETENTION_BATCH_SIZE,
			continuationScheduled: true,
		});
		await expect(
			t.run(async (ctx) => ({
				alerts: (await ctx.db.query('deliverabilityRegressionAlerts').collect()).length,
				recipients: (await ctx.db.query('deliverabilityAlertRecipients').collect()).length,
			}))
		).resolves.toEqual({ alerts: 1, recipients: 1 });

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepAlerts, { startedAt: now })
		).resolves.toMatchObject({ examined: 1, deleted: 1 });
		await expect(
			t.run(async (ctx) => ({
				alerts: (await ctx.db.query('deliverabilityRegressionAlerts').collect()).length,
				recipients: (await ctx.db.query('deliverabilityAlertRecipients').collect()).length,
			}))
		).resolves.toEqual({ alerts: 0, recipients: 0 });
	});

	it('deletes only old terminal loopback attempts', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_COMPLETED_RETENTION_MS - 1;
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'retention.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			})
		);
		const insertAttempt = (
			attemptId: string,
			status: 'sending' | 'passed' | 'failed' | 'timed_out',
			completedAt?: number
		) =>
			t.run((ctx) =>
				ctx.db.insert('deliverabilityLoopbackAttempts', {
					organizationId: ORGANIZATION_ID,
					attemptId,
					domainId,
					domain: 'retention.example',
					correlationTokenHash: `hash:${attemptId}`,
					status,
					startedAt: completedAt ?? now,
					...(completedAt === undefined ? {} : { completedAt }),
					expiresAt: now + 60_000,
				})
			);
		const staleTerminalId = await insertAttempt('stale-terminal', 'passed', old);
		const recentTerminalId = await insertAttempt('recent-terminal', 'failed', now);
		const nonterminalId = await insertAttempt('nonterminal', 'sending', old);

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepLoopbackAttempts, {
				startedAt: now,
			})
		).resolves.toMatchObject({ examined: 2, deleted: 1 });

		const remainingIds = await t.run(async (ctx) =>
			(await ctx.db.query('deliverabilityLoopbackAttempts').collect()).map((row) => row._id)
		);
		expect(remainingIds).not.toContain(staleTerminalId);
		expect(remainingIds).toEqual(expect.arrayContaining([recentTerminalId, nonterminalId]));
	});

	it('reconciles overdue nonterminal probes before completed-attempt retention', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_COMPLETED_RETENTION_MS - 1;
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'reconcile.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.run(async (ctx) => {
			for (const attempt of [
				{ attemptId: 'expired-sending', status: 'sending' as const, expiresAt: old },
				{
					attemptId: 'expired-awaiting',
					status: 'awaiting_inbound' as const,
					expiresAt: old,
				},
				{ attemptId: 'already-terminal', status: 'passed' as const, expiresAt: old },
				{ attemptId: 'not-expired', status: 'sending' as const, expiresAt: now + 60_000 },
			]) {
				await ctx.db.insert('deliverabilityLoopbackAttempts', {
					organizationId: ORGANIZATION_ID,
					attemptId: attempt.attemptId,
					domainId,
					domain: 'reconcile.example',
					correlationTokenHash: `hash:${attempt.attemptId}`,
					status: attempt.status,
					startedAt: old,
					...(attempt.status === 'passed' ? { completedAt: old } : {}),
					expiresAt: attempt.expiresAt,
				});
			}
		});

		await expect(
			t.mutation(internal.delivery.checklistRetention.reconcileExpiredLoopbackAttempts, {
				startedAt: now,
			})
		).resolves.toEqual({
			examined: 3,
			reconciled: 2,
			continuationScheduled: false,
		});
		const attempts = await t.run(
			async (ctx) => await ctx.db.query('deliverabilityLoopbackAttempts').collect()
		);
		for (const attemptId of ['expired-sending', 'expired-awaiting']) {
			expect(attempts.find((attempt) => attempt.attemptId === attemptId)).toMatchObject({
				status: 'timed_out',
				completedAt: now,
			});
		}
		expect(attempts.find((attempt) => attempt.attemptId === 'not-expired')?.status).toBe('sending');
	});

	it('processes at most one cursor page per evidence mutation', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - DELIVERABILITY_EVIDENCE_RETENTION_MS - 1;
		await t.run(async (ctx) => {
			for (let index = 0; index < DELIVERABILITY_RETENTION_BATCH_SIZE + 3; index++) {
				await ctx.db.insert('deliverabilityEvidence', evidenceValues(old - index, `old-${index}`));
			}
		});

		await expect(
			t.mutation(internal.delivery.checklistRetention.sweepEvidence, { startedAt: now })
		).resolves.toEqual({
			examined: DELIVERABILITY_RETENTION_BATCH_SIZE,
			deleted: DELIVERABILITY_RETENTION_BATCH_SIZE,
			continuationScheduled: true,
		});
		expect(
			await t.run(async (ctx) => (await ctx.db.query('deliverabilityEvidence').collect()).length)
		).toBe(3);

		await t.finishAllScheduledFunctions(() => vi.runAllTimers());
		expect(
			await t.run(async (ctx) => (await ctx.db.query('deliverabilityEvidence').collect()).length)
		).toBe(0);
	});
});
