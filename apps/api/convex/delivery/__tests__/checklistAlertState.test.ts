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
});
