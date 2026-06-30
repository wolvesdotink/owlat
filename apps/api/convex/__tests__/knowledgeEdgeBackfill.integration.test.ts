import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestKnowledgeEntry, enableFeatures } from './factories';

const sessionMocks = vi.hoisted(() => ({
	requireAdminContext: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user-123'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user-123', role: 'owner' }),
		requireAdminContext: sessionMocks.requireAdminContext,
	};
});

sessionMocks.requireAdminContext.mockResolvedValue({ userId: 'test-user-123', role: 'owner' });

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

// Mirror the knowledge maintenance test's module set — exclude the 'use node'
// LLM/embedding modules so the test runtime stays light. We never DRAIN the
// scheduled `inferRelations` actions (only assert they were scheduled), so the
// excluded modules are never loaded.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
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

/** Count pending scheduled functions whose name mentions `needle`. */
async function countScheduled(
	t: ReturnType<typeof convexTest>,
	needle: string,
): Promise<number> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		return jobs.filter((j) => (j.name ?? '').includes(needle)).length;
	});
}

// =====================================================================
// 1. setFeatureFlag('ai.knowledge.autoLink', true) kicks off the backfill
// =====================================================================

describe('featureFlags.setFeatureFlag — ai.knowledge.autoLink edge backfill kick-off', () => {
	it('creates one running knowledgeEdgeBackfillJobs row + audit log on first enable', async () => {
		const t = convexTest(schema, modules);

		// Seed two existing entries so totalCount > 0.
		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ sourceType: 'manual' }));
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ sourceType: 'manual' }));
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.knowledge.autoLink', value: true }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeEdgeBackfillJobs').collect();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.status).toBe('running');
			expect(jobs[0]!.triggeredBy).toBe('test-user-123');
			expect(jobs[0]!.totalCount).toBe(2);
			expect(jobs[0]!.scannedCount).toBe(0);
			expect(jobs[0]!.scheduledCount).toBe(0);

			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'knowledge.edge_backfill_started'))
				.collect();
			expect(logs).toHaveLength(1);
			expect(logs[0]!.resource).toBe('knowledge_config');
			expect(logs[0]!.userId).toBe('test-user-123');
		});

		// The kick-off schedules the first page of the walker.
		expect(await countScheduled(t, 'runEdgeBackfill')).toBe(1);
	});

	it('does NOT create a second job when a prior job exists (hasAnyJob guard)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.knowledge.autoLink': false, 'ai.knowledge': true, ai: true },
				createdAt: Date.now(),
			});
			await ctx.db.insert('knowledgeEdgeBackfillJobs', {
				status: 'completed',
				triggeredBy: 'previous-user',
				totalCount: 50,
				scannedCount: 50,
				scheduledCount: 50,
				startedAt: Date.now() - 1_000_000,
				updatedAt: Date.now() - 500_000,
				finishedAt: Date.now() - 500_000,
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.knowledge.autoLink', value: true }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeEdgeBackfillJobs').collect();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.triggeredBy).toBe('previous-user');
		});
	});

	it('does NOT enqueue when autoLink is already on (no-op true→true)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.knowledge.autoLink': true, 'ai.knowledge': true, ai: true },
				createdAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.knowledge.autoLink', value: true }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeEdgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});

	it('does NOT enqueue on a true→false toggle', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.knowledge.autoLink': true, 'ai.knowledge': true, ai: true },
				createdAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.knowledge.autoLink', value: false }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeEdgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});
});

// =====================================================================
// 2. runEdgeBackfill — pagination + per-entry scheduling + self-reschedule
// =====================================================================

describe('knowledgeEdgeBackfill.runEdgeBackfill — pagination', () => {
	it('schedules inferRelations per entry, advances the cursor, and self-reschedules', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		let jobId!: Id<'knowledgeEdgeBackfillJobs'>;
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ sourceType: 'manual', title: `entry-${i}` })
				);
			}
			jobId = await ctx.db.insert('knowledgeEdgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 3,
				scannedCount: 0,
				scheduledCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Page 1 (size 2): schedules 2 inferRelations, leaves the job running, and
		// self-reschedules the next page.
		await t.mutation(internal.knowledge.edgeBackfill.runEdgeBackfill, {
			jobId,
			pageSize: 2,
		});

		const job1 = await t.run(async (ctx) => ctx.db.get(jobId));
		expect(job1!.status).toBe('running');
		expect(job1!.scannedCount).toBe(2);
		expect(job1!.scheduledCount).toBe(2);
		expect(job1!.cursor).toBeDefined();
		expect(await countScheduled(t, 'inferRelations')).toBe(2);
		// Self-reschedule of the next page proves the walker advances on its own.
		expect(await countScheduled(t, 'runEdgeBackfill')).toBe(1);

		// Page 2 (size 2): consumes the tail entry, schedules its inferRelations,
		// and finalizes the job as completed.
		await t.mutation(internal.knowledge.edgeBackfill.runEdgeBackfill, {
			jobId,
			cursor: job1!.cursor,
			pageSize: 2,
		});

		const job2 = await t.run(async (ctx) => ctx.db.get(jobId));
		expect(job2!.status).toBe('completed');
		expect(job2!.scannedCount).toBe(3);
		expect(job2!.scheduledCount).toBe(3);
		expect(job2!.finishedAt).toBeDefined();
		// One inferRelations per existing entry, exactly once.
		expect(await countScheduled(t, 'inferRelations')).toBe(3);
	});

	it('cancels the job if autoLink is disabled mid-walk', async () => {
		const t = convexTest(schema, modules);
		// Flag left OFF (no instanceSettings) → defaults to off.

		let jobId!: Id<'knowledgeEdgeBackfillJobs'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ sourceType: 'manual' }));
			jobId = await ctx.db.insert('knowledgeEdgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 1,
				scannedCount: 0,
				scheduledCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.knowledge.edgeBackfill.runEdgeBackfill, { jobId });

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('cancelled');
			expect(job!.scannedCount).toBe(0);
		});
		expect(await countScheduled(t, 'inferRelations')).toBe(0);
	});

	it('exits cleanly without scheduling when the job is already cancelled', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		let jobId!: Id<'knowledgeEdgeBackfillJobs'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ sourceType: 'manual' }));
			jobId = await ctx.db.insert('knowledgeEdgeBackfillJobs', {
				status: 'cancelled',
				triggeredBy: 'test',
				totalCount: 1,
				scannedCount: 0,
				scheduledCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				finishedAt: Date.now(),
			});
		});

		await t.mutation(internal.knowledge.edgeBackfill.runEdgeBackfill, { jobId });

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('cancelled');
			expect(job!.scannedCount).toBe(0);
		});
		expect(await countScheduled(t, 'inferRelations')).toBe(0);
	});
});

// =====================================================================
// 3. cancel — admin lever
// =====================================================================

describe('knowledgeEdgeBackfill.cancel', () => {
	it('flips a running job to cancelled and writes an audit log', async () => {
		const t = convexTest(schema, modules);

		let jobId!: Id<'knowledgeEdgeBackfillJobs'>;
		await t.run(async (ctx) => {
			jobId = await ctx.db.insert('knowledgeEdgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 100,
				scannedCount: 5,
				scheduledCount: 5,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.withIdentity(testIdentity).mutation(
			api.knowledge.edgeBackfill.cancel,
			{}
		);
		expect(result).toBe(true);

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('cancelled');
			expect(job!.finishedAt).toBeDefined();

			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'knowledge.edge_backfill_cancelled'))
				.collect();
			expect(logs).toHaveLength(1);
		});
	});

	it('returns false when there is no active job', async () => {
		const t = convexTest(schema, modules);
		const result = await t.withIdentity(testIdentity).mutation(
			api.knowledge.edgeBackfill.cancel,
			{}
		);
		expect(result).toBe(false);
	});
});
