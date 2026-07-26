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
		await record('transient', 'warn', 'checklist.orchestrator', 2_000);
		await record('fail', 'fail', 'mta.fcrdns', 3_000);
		const alert = await t.run((ctx) => ctx.db.query('deliverabilityRegressionAlerts').unique());
		expect(alert?.message).toContain('Prove you own your server');
		expect(alert?.message).not.toContain('deployment.ptr');
		expect(alert?.resolvedAt).toBeUndefined();
		await record('recovered', 'pass', 'mta.fcrdns', 4_000);
		expect(
			await t.run((ctx) => ctx.db.query('deliverabilityRegressionAlerts').unique())
		).toMatchObject({ resolvedAt: 4_000 });
	});
});
