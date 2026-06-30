import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestAutonomyRule, enableFeatures } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') && !path.includes('agentSecurity') && !path.includes('agentContext') && !path.includes('agentClassifier') && !path.includes('agentDrafter') && !path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') && !path.includes('knowledgeExtraction') && !path.includes('semanticFileProcessing') && !path.includes('visualizationAgent') && !path.includes('llmProvider')
	)
);

// ============ listRules ============

describe('autonomy.listRules', () => {
	it('should return empty array when no rules exist', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		const rules = await t.query(api.autonomy.listRules);
		expect(rules).toEqual([]);
	});

	it('should return all rules', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);

		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'support' }));
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'sales' }));
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'billing' }));
		});

		const rules = await t.query(api.autonomy.listRules);
		expect(rules).toHaveLength(3);
	});
});

// ============ checkPermissionInternal (route-step decision + flag gate) ============

describe('autonomy.checkPermissionInternal', () => {
	it('returns mode=disabled when the ai.autonomy flag is off (route falls back to global config)', async () => {
		const t = convexTest(schema, modules);
		// Flag NOT enabled → autonomy off, even with a matching rule present.
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				autoApproveThreshold: 0.5,
				maxDailyAutoActions: 100,
				isEnabled: true,
			}));
		});

		const result = await t.query(internal.autonomy.checkPermissionInternal, {
			category: 'support',
			confidence: 0.95,
		});
		expect(result.mode).toBe('disabled');
	});

	it('enabled + no rule for category → never auto-approved', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);

		const result = await t.query(internal.autonomy.checkPermissionInternal, {
			category: 'sales',
			confidence: 0.99,
		});
		expect(result.mode).toBe('enabled');
		if (result.mode !== 'enabled') return;
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('No autonomy rule');
	});

	it('enabled + rule + confidence over threshold → allowed', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				autoApproveThreshold: 0.8,
				maxDailyAutoActions: 100,
				isEnabled: true,
			}));
		});

		const result = await t.query(internal.autonomy.checkPermissionInternal, {
			category: 'support',
			confidence: 0.9,
		});
		expect(result.mode).toBe('enabled');
		if (result.mode !== 'enabled') return;
		expect(result.allowed).toBe(true);
	});

	it('enabled + confidence below threshold → denied', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				autoApproveThreshold: 0.85,
				maxDailyAutoActions: 100,
				isEnabled: true,
			}));
		});

		const result = await t.query(internal.autonomy.checkPermissionInternal, {
			category: 'support',
			confidence: 0.6,
		});
		expect(result.mode).toBe('enabled');
		if (result.mode !== 'enabled') return;
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('below category threshold');
	});

	it('enabled + open circuit breaker → denied even at high confidence', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				autoApproveThreshold: 0.5,
				maxDailyAutoActions: 100,
				isEnabled: true,
			}));
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: 'rejection_spike',
				state: 'open',
				threshold: 0.4,
				currentValue: 0.6,
				trippedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		const result = await t.query(internal.autonomy.checkPermissionInternal, {
			category: 'support',
			confidence: 0.99,
		});
		expect(result.mode).toBe('enabled');
		if (result.mode !== 'enabled') return;
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('Circuit breaker');
	});
});

// ============ getFeedbackCountsInternal (rejection-spike breaker input) ============

describe('autonomy.getFeedbackCountsInternal', () => {
	it('splits counts by action since the window start', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			const mk = (action: 'approved' | 'rejected' | 'edited', createdAt: number) =>
				ctx.db.insert('autonomyFeedback', {
					category: 'support',
					action,
					agentConfidence: 0.8,
					createdAt,
				});
			await mk('approved', now - 1000);
			await mk('rejected', now - 2000);
			await mk('rejected', now - 3000);
			await mk('edited', now - 4000);
			// Outside the window — must be excluded.
			await mk('rejected', now - 48 * 60 * 60 * 1000);
		});

		const counts = await t.query(internal.autonomy.getFeedbackCountsInternal, {
			since: now - 24 * 60 * 60 * 1000,
		});
		expect(counts.approved).toBe(1);
		expect(counts.rejected).toBe(2);
		expect(counts.edited).toBe(1);
		expect(counts.total).toBe(4);
	});
});

// ============ upsertRule ============

describe('autonomy.upsertRule', () => {
	it('should create a new rule when none exists', async () => {
		const t = convexTest(schema, modules);

		const ruleId = await t.mutation(api.autonomy.upsertRule, {
			category: 'support',
			autoApproveThreshold: 0.85,
			maxDailyAutoActions: 50,
			isEnabled: true,
		});

		expect(ruleId).toBeDefined();

		await t.run(async (ctx) => {
			const rule = await ctx.db.get(ruleId);
			expect(rule).not.toBeNull();
			expect(rule!.category).toBe('support');
			expect(rule!.autoApproveThreshold).toBe(0.85);
			expect(rule!.maxDailyAutoActions).toBe(50);
			expect(rule!.isEnabled).toBe(true);
			expect(rule!.createdAt).toBeTypeOf('number');
		});
	});

	it('should update an existing rule for the same category', async () => {
		const t = convexTest(schema, modules);

		const ruleId = await t.mutation(api.autonomy.upsertRule, {
			category: 'sales',
			autoApproveThreshold: 0.7,
			maxDailyAutoActions: 30,
			isEnabled: true,
		});

		const updatedId = await t.mutation(api.autonomy.upsertRule, {
			category: 'sales',
			autoApproveThreshold: 0.9,
			maxDailyAutoActions: 60,
			isEnabled: false,
		});

		expect(updatedId).toEqual(ruleId);

		await t.run(async (ctx) => {
			const rule = await ctx.db.get(ruleId);
			expect(rule!.autoApproveThreshold).toBe(0.9);
			expect(rule!.maxDailyAutoActions).toBe(60);
			expect(rule!.isEnabled).toBe(false);
		});
	});
});

// ============ deleteRule ============

describe('autonomy.deleteRule', () => {
	it('should delete an existing rule', async () => {
		const t = convexTest(schema, modules);
		let ruleId!: Id<'autonomyRules'>;

		await t.run(async (ctx) => {
			ruleId = await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'billing' }));
		});

		await t.mutation(api.autonomy.deleteRule, { ruleId });

		await t.run(async (ctx) => {
			const rule = await ctx.db.get(ruleId);
			expect(rule).toBeNull();
		});
	});
});

// ============ recordFeedback (internal) ============

describe('autonomy.recordFeedback', () => {
	it('should record feedback with a linked rule', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'support' }));
		});

		await t.mutation(internal.autonomy.recordFeedback, {
			category: 'support',
			action: 'approved',
			agentConfidence: 0.92,
			userFeedback: 'Good response',
		});

		await t.run(async (ctx) => {
			const feedback = await ctx.db.query('autonomyFeedback').collect();
			expect(feedback).toHaveLength(1);
			expect(feedback[0]!.category).toBe('support');
			expect(feedback[0]!.action).toBe('approved');
			expect(feedback[0]!.agentConfidence).toBe(0.92);
			expect(feedback[0]!.userFeedback).toBe('Good response');
			expect(feedback[0]!.ruleId).toBeDefined();
		});
	});

	it('should record feedback even without a matching rule', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.autonomy.recordFeedback, {
			category: 'unknown',
			action: 'rejected',
			agentConfidence: 0.3,
		});

		await t.run(async (ctx) => {
			const feedback = await ctx.db.query('autonomyFeedback').collect();
			expect(feedback).toHaveLength(1);
			expect(feedback[0]!.ruleId).toBeUndefined();
		});
	});
});

// ============ incrementDailyCount (internal) ============

describe('autonomy.incrementDailyCount', () => {
	it('should increment the daily count on a rule', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				currentDailyCount: 5,
				dailyCountResetAt: Date.now(),
			}));
		});

		await t.mutation(internal.autonomy.incrementDailyCount, { category: 'support' });

		await t.run(async (ctx) => {
			const rule = await ctx.db
				.query('autonomyRules')
				.withIndex('by_category', (q) => q.eq('category', 'support'))
				.first();
			expect(rule!.currentDailyCount).toBe(6);
		});
	});

	it('should do nothing if the category does not exist', async () => {
		const t = convexTest(schema, modules);
		// Should not throw, and reports not-allowed (no rule = never auto-approved).
		const result = await t.mutation(internal.autonomy.incrementDailyCount, { category: 'nonexistent' });
		expect(result.allowed).toBe(false);
	});

	it('charges atomically: returns allowed and increments while under the cap', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				maxDailyAutoActions: 3,
				currentDailyCount: 2,
				dailyCountResetAt: Date.now(),
			}));
		});

		const result = await t.mutation(internal.autonomy.incrementDailyCount, { category: 'support' });
		expect(result.allowed).toBe(true);

		await t.run(async (ctx) => {
			const rule = await ctx.db
				.query('autonomyRules')
				.withIndex('by_category', (q) => q.eq('category', 'support'))
				.first();
			expect(rule!.currentDailyCount).toBe(3);
		});
	});

	it('denies and does NOT increment once the cap is reached (the race fix)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				maxDailyAutoActions: 3,
				currentDailyCount: 3, // already at cap
				dailyCountResetAt: Date.now(),
			}));
		});

		const result = await t.mutation(internal.autonomy.incrementDailyCount, { category: 'support' });
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('Daily auto-action limit');

		await t.run(async (ctx) => {
			const rule = await ctx.db
				.query('autonomyRules')
				.withIndex('by_category', (q) => q.eq('category', 'support'))
				.first();
			// Count must NOT have gone to 4 — the at-cap charge is refused.
			expect(rule!.currentDailyCount).toBe(3);
		});
	});

	it('resets the rolling window before charging when 24h have elapsed', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({
				category: 'support',
				maxDailyAutoActions: 3,
				currentDailyCount: 3, // at cap, but stale window
				dailyCountResetAt: Date.now() - 25 * 60 * 60 * 1000, // >24h ago
			}));
		});

		const result = await t.mutation(internal.autonomy.incrementDailyCount, { category: 'support' });
		expect(result.allowed).toBe(true); // window reset → count starts fresh

		await t.run(async (ctx) => {
			const rule = await ctx.db
				.query('autonomyRules')
				.withIndex('by_category', (q) => q.eq('category', 'support'))
				.first();
			expect(rule!.currentDailyCount).toBe(1); // reset to 0 then charged once
		});
	});
});

// ============ resetDailyCounts (internal) ============

describe('autonomy.resetDailyCounts', () => {
	it('should reset daily counts on all rules', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'support', currentDailyCount: 10 }));
			await ctx.db.insert('autonomyRules', createTestAutonomyRule({ category: 'sales', currentDailyCount: 25 }));
		});

		await t.mutation(internal.autonomy.resetDailyCounts);

		await t.run(async (ctx) => {
			const rules = await ctx.db.query('autonomyRules').collect();
			for (const rule of rules) {
				expect(rule.currentDailyCount).toBe(0);
				expect(rule.dailyCountResetAt).toBeTypeOf('number');
			}
		});
	});
});
