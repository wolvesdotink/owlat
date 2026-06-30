import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestEmailSend, createTestCampaign, createTestContact } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

/** Start-of-today UTC (matches the reputation module's bucket boundary), so a
 * seeded bucket sits inside summarize()'s 30-day rolling window. */
function todayUtc(): number {
	const d = new Date();
	d.setUTCHours(0, 0, 0, 0);
	return d.getTime();
}

type Rep = { sent: number; delivered: number; bounced: number; complaints?: number; hardBounced?: number };

async function seedReputation(
	t: ReturnType<typeof convexTest>,
	{ sent, delivered, bounced, complaints = 0, hardBounced = 0 }: Rep
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('sendingReputation', {
			scope: 'org',
			periodStart: todayUtc(),
			shardKey: 0,
			totalSent: sent,
			totalDelivered: delivered,
			totalBounced: bounced,
			totalHardBounced: hardBounced,
			totalComplaints: complaints,
			lastCalculatedAt: Date.now(),
		});
	});
}

async function seedQueued(t: ReturnType<typeof convexTest>, count: number) {
	await t.run(async (ctx) => {
		// emailSends carry real FKs, so seed a parent campaign + contact first.
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact());
		for (let i = 0; i < count; i++) {
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ status: 'queued', campaignId, contactId })
			);
		}
	});
}

describe('systemHealth.getHealthStats', () => {
	it('reports operational with zeroed stats on a fresh deployment', async () => {
		const t = convexTest(schema, modules);
		const r = await t.withIdentity(testIdentity).query(api.systemHealth.getHealthStats, {});
		expect(r.status).toBe('operational');
		expect(r.emailQueueDepth).toBe(0);
		expect(r.recentDeliveryRate).toBeNull();
		expect(r.stats).toEqual({ recentSent: 0, recentDelivered: 0, recentBounced: 0 });
		expect(r.issues).toEqual([]);
	});

	it('derives delivery rate + stats from the reputation window', async () => {
		const t = convexTest(schema, modules);
		await seedReputation(t, { sent: 100, delivered: 95, bounced: 2 });
		const r = await t.withIdentity(testIdentity).query(api.systemHealth.getHealthStats, {});
		expect(r.stats).toEqual({ recentSent: 100, recentDelivered: 95, recentBounced: 2 });
		expect(r.recentDeliveryRate).toBe(95);
		expect(r.status).toBe('operational');
	});

	it('flags an elevated bounce rate (>5%) as degraded', async () => {
		const t = convexTest(schema, modules);
		await seedReputation(t, { sent: 100, delivered: 92, bounced: 7 });
		const r = await t.withIdentity(testIdentity).query(api.systemHealth.getHealthStats, {});
		expect(r.status).toBe('degraded');
		expect(r.issues.some((i) => /bounce/i.test(i))).toBe(true);
	});

	it('flags a high bounce rate (>10%) as an issue', async () => {
		const t = convexTest(schema, modules);
		await seedReputation(t, { sent: 100, delivered: 80, bounced: 12 });
		const r = await t.withIdentity(testIdentity).query(api.systemHealth.getHealthStats, {});
		expect(r.status).toBe('issue');
		expect(r.issues.some((i) => /high bounce rate/i.test(i))).toBe(true);
	});

	it('ignores bounces below the minimum sample size', async () => {
		const t = convexTest(schema, modules);
		// 2 sent, 1 bounced = 50% rate, but under the >10 sample guard.
		await seedReputation(t, { sent: 2, delivered: 1, bounced: 1 });
		const r = await t.withIdentity(testIdentity).query(api.systemHealth.getHealthStats, {});
		expect(r.status).toBe('operational');
	});

	it('counts queued sends and degrades when the queue builds up (>100)', async () => {
		const t = convexTest(schema, modules);
		await seedQueued(t, 101);
		const r = await t.withIdentity(testIdentity).query(api.systemHealth.getHealthStats, {});
		expect(r.emailQueueDepth).toBe(101);
		expect(r.status).toBe('degraded');
		expect(r.issues.some((i) => /queued/i.test(i))).toBe(true);
	});
});
