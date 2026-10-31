import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import schema from '../../schema';
import { requireAdminContext, requireOrgPermission } from '../../lib/sessionOrganization';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireAdminContext: vi.fn().mockResolvedValue({
			userId: 'admin',
			role: 'admin',
			activeOrganizationId: 'org',
		}),
		requireOrgPermission: vi.fn().mockResolvedValue({
			userId: 'admin',
			role: 'admin',
			activeOrganizationId: 'org',
		}),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

async function insertRegressionAlert(ctx: MutationCtx, identity: string) {
	const evidence = {
		organizationId: 'org',
		itemId: 'deployment.ptr' as const,
		scopeKind: 'deployment' as const,
		targetKey: '3:org|deployment',
		attemptId: 'attempt',
		validator: 'test',
		status: 'fail' as const,
		observedValues: [],
		diagnostic: 'failed',
		observedAt: 1_000,
		createdAt: 1_000,
	};
	const previousEvidenceId = await ctx.db.insert('deliverabilityEvidence', {
		...evidence,
		attemptId: 'previous',
		status: 'pass',
	});
	const regressedEvidenceId = await ctx.db.insert('deliverabilityEvidence', evidence);
	return ctx.db.insert('deliverabilityRegressionAlerts', {
		organizationId: 'org',
		identity,
		itemId: 'deployment.ptr',
		targetKey: '3:org|deployment',
		previousEvidenceId,
		regressedEvidenceId,
		observedAt: 1_000,
		message: 'failed',
		emailNotificationState: 'pending',
		createdAt: 1_000,
	});
}

describe('deliverability alert management', () => {
	it('cancels queued recipients, preserves in-flight work, and acknowledges manual resolution', async () => {
		const t = convexTest(schema, modules);
		const alertId = await t.run(async (ctx) => {
			const alertId = await insertRegressionAlert(ctx, 'manual-resolution');
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId,
				userId: 'queued',
				status: 'pending',
				attemptCount: 1,
				nextAttemptAt: 5_000,
			});
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId,
				userId: 'in-flight',
				status: 'sending',
				attemptCount: 1,
				attemptToken: 'send-token',
				attemptStartedAt: 2_000,
			});
			return alertId;
		});

		await expect(
			t.mutation(api.delivery.checklistAlertManagement.resolve, { alertId })
		).resolves.toBe(true);
		const state = await t.run(async (ctx) => ({
			alert: await ctx.db.get(alertId),
			recipients: await ctx.db.query('deliverabilityAlertRecipients').collect(),
		}));
		expect(state.alert?.resolvedAt).toEqual(expect.any(Number));
		expect(state.alert?.acknowledgedAt).toBe(state.alert?.resolvedAt);
		expect(state.alert?.emailNotificationState).toBe('pending');
		expect(state.recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ userId: 'queued', status: 'cancelled' }),
				expect.objectContaining({
					userId: 'in-flight',
					status: 'sending',
					attemptToken: 'send-token',
				}),
			])
		);
	});

	it('makes a pending-only alert terminal and clears stale claim metadata', async () => {
		const t = convexTest(schema, modules);
		const alertId = await t.run(async (ctx) => {
			const alertId = await insertRegressionAlert(ctx, 'pending-only-resolution');
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId,
				userId: 'queued',
				status: 'pending',
				attemptCount: 2,
				attemptToken: 'stale-claim',
				attemptStartedAt: 2_000,
				nextAttemptAt: 5_000,
				unavailableReason: 'missing_email',
			});
			return alertId;
		});

		await expect(
			t.mutation(api.delivery.checklistAlertManagement.resolve, { alertId })
		).resolves.toBe(true);
		const state = await t.run(async (ctx) => ({
			alert: await ctx.db.get(alertId),
			recipient: await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_alert', (q) => q.eq('alertId', alertId))
				.unique(),
		}));
		expect(state.alert?.emailNotificationState).toBe('unavailable');
		expect(state.alert?.emailNotifiedAt).toBeUndefined();
		expect(state.recipient).toMatchObject({
			status: 'cancelled',
			attemptCount: 2,
		});
		expect(state.recipient).not.toHaveProperty('attemptToken');
		expect(state.recipient).not.toHaveProperty('attemptStartedAt');
		expect(state.recipient).not.toHaveProperty('nextAttemptAt');
		expect(state.recipient).not.toHaveProperty('unavailableReason');
	});

	it("reads another organization's alert as missing, on the floor session alone", async () => {
		const t = convexTest(schema, modules);
		const alertId = await t.run(async (ctx) => {
			const alertId = await insertRegressionAlert(ctx, 'foreign-org');
			await ctx.db.patch(alertId, { organizationId: 'other-org' });
			return alertId;
		});
		vi.mocked(requireAdminContext).mockClear();
		vi.mocked(requireOrgPermission).mockClear();

		await expect(
			t.mutation(api.delivery.checklistAlertManagement.acknowledge, { alertId })
		).rejects.toThrow(/Deliverability alert not found/);
		await expect(
			t.mutation(api.delivery.checklistAlertManagement.resolve, { alertId })
		).rejects.toThrow(/Deliverability alert not found/);
		expect((await t.run(async (ctx) => ctx.db.get(alertId)))?.acknowledgedAt).toBeUndefined();
		// The admin floor resolves the session once per call; the alert lookup
		// reuses it instead of resolving again.
		expect(vi.mocked(requireAdminContext)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(requireOrgPermission)).not.toHaveBeenCalled();
	});
});
