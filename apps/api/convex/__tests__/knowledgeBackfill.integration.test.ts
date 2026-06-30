import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestInboundMessage,
	createTestKnowledgeEntry,
	enableFeatures,
} from './factories';

const sessionMocks = vi.hoisted(() => ({
	getUserIdFromSession: vi.fn(),
	getMutationContext: vi.fn(),
	requireAdminContext: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: sessionMocks.getUserIdFromSession,
		getMutationContext: sessionMocks.getMutationContext,
		requireAdminContext: sessionMocks.requireAdminContext,
	};
});

// Default to an owner identity for every test; individual tests can override.
sessionMocks.getUserIdFromSession.mockResolvedValue('test-user-123');
sessionMocks.getMutationContext.mockResolvedValue({ userId: 'test-user-123', role: 'owner' });
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

// `knowledgeExtraction` is `'use node'` and pulls in LLM/embedding deps — exclude
// it from the test runtime. The backfill chunk runner is tested via the skip
// path (pre-create knowledgeEntries with sourceType:'agent_extracted') so the
// `extractFromMessage` action is never invoked from inside tests.
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

// Suppress "Could not find module" rejections from the scheduler trying to
// run scheduled functions whose target module is excluded above (the false→true
// toggle test legitimately schedules a chunk runner; we don't want that schedule
// to actually fire in tests).
const suppressedErrors: Error[] = [];
const unhandledRejectionHandler = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressedErrors.push(err);
	} else {
		throw err;
	}
};

beforeEach(() => {
	suppressedErrors.length = 0;
	process.on('unhandledRejection', unhandledRejectionHandler);
});

afterEach(() => {
	process.removeListener('unhandledRejection', unhandledRejectionHandler);
});

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

/** Minimal inbound message data for ctx.db.insert */
function msgData(overrides: Record<string, unknown> = {}) {
	return createTestInboundMessage({ threadId: undefined, contactId: undefined, ...overrides });
}

/** A knowledge entry that idempotency lookups will match against */
function preExtractedEntry(inboundMessageId: Id<'inboundMessages'>) {
	return createTestKnowledgeEntry({
		sourceType: 'agent_extracted',
		sourceId: inboundMessageId,
	});
}

// =====================================================================
// 1. setFeatureFlag('ai.agent', true) kicks off the backfill the first time
// =====================================================================

describe('featureFlags.setFeatureFlag — ai.agent backfill kick-off', () => {
	it('creates a knowledgeBackfillJobs row in running on first ai.agent enable', async () => {
		const t = convexTest(schema, modules);

		// Seed two inbound messages so totalCount > 0
		await t.run(async (ctx) => {
			await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1000 }));
			await ctx.db.insert('inboundMessages', msgData({ receivedAt: 2000 }));
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.agent', value: true }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.status).toBe('running');
			expect(jobs[0]!.triggeredBy).toBe('test-user-123');
			expect(jobs[0]!.totalCount).toBe(2);
			expect(jobs[0]!.scannedCount).toBe(0);
		});
	});

	it('writes an agent.backfill_started audit log on first kick-off', async () => {
		const t = convexTest(schema, modules);

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.agent', value: true }
		);

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'agent.backfill_started'))
				.collect();
			expect(logs.length).toBe(1);
			expect(logs[0]!.resource).toBe('agent_config');
			expect(logs[0]!.userId).toBe('test-user-123');
		});
	});

	it('does NOT create a second job when ai.agent re-enables after a completed run', async () => {
		const t = convexTest(schema, modules);

		// Pre-existing completed backfill job — the existence-gate trips
		// regardless of the flag's current state.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.agent': false, ai: true, inbox: true },
				createdAt: Date.now(),
			});
			await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'completed',
				triggeredBy: 'previous-user',
				totalCount: 100,
				scannedCount: 100,
				extractedCount: 80,
				skippedCount: 20,
				errorCount: 0,
				startedAt: Date.now() - 1_000_000,
				updatedAt: Date.now() - 500_000,
				finishedAt: Date.now() - 500_000,
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.agent', value: true }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.triggeredBy).toBe('previous-user');
		});
	});

	it('does NOT enqueue when ai.agent is already on (no-op true→true)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.agent': true, ai: true, inbox: true },
				createdAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.agent', value: true }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});

	it('does NOT enqueue on a true→false toggle', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'ai.agent': true, ai: true, inbox: true },
				createdAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.organizations.featureFlags.setFeatureFlag,
			{ flag: 'ai.agent', value: false }
		);

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('knowledgeBackfillJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});
});

// =====================================================================
// 2. runChunk — idempotency / skip path
// =====================================================================

describe('knowledgeBackfill.runChunk — idempotency', () => {
	it('skips messages that already have a knowledgeEntries row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);

		let jobId!: Id<'knowledgeBackfillJobs'>;
		await t.run(async (ctx) => {
			// Seed two messages, both pre-extracted
			const msg1 = await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1000 }));
			const msg2 = await ctx.db.insert('inboundMessages', msgData({ receivedAt: 2000 }));

			await ctx.db.insert('knowledgeEntries', preExtractedEntry(msg1));
			await ctx.db.insert('knowledgeEntries', preExtractedEntry(msg2));

			jobId = await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 2,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.action(internal.agent.knowledgeBackfill.runChunk, {
			jobId,
			chunkSize: 30,
		});

		// Drain the chained schedule (there's no more, so this completes the job)
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job).toBeDefined();
			expect(job!.status).toBe('completed');
			expect(job!.scannedCount).toBe(2);
			expect(job!.skippedCount).toBe(2);
			expect(job!.extractedCount).toBe(0);
			expect(job!.errorCount).toBe(0);
		});
	});
});

// =====================================================================
// 3. runChunk — mid-scan disable
// =====================================================================

describe('knowledgeBackfill.runChunk — mid-scan disable', () => {
	it('cancels the job if ai.agent flag is off at chunk start', async () => {
		const t = convexTest(schema, modules);

		let jobId!: Id<'knowledgeBackfillJobs'>;
		await t.run(async (ctx) => {
			// ai.agent flag unset → defaults to off. The chunk runner short-circuits.
			// Seed a message (it would be processed if enabled, but we expect short-circuit)
			await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1000 }));

			jobId = await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 1,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.action(internal.agent.knowledgeBackfill.runChunk, {
			jobId,
			chunkSize: 30,
		});

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('cancelled');
			expect(job!.scannedCount).toBe(0);
		});
	});
});

// =====================================================================
// 4. runChunk — cursor advances across multiple chunks
// =====================================================================

describe('knowledgeBackfill.runChunk — cursor pagination', () => {
	it('first chunk processes chunkSize messages and advances cursor + schedules next', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);

		let jobId!: Id<'knowledgeBackfillJobs'>;
		const insertedIds: Id<'inboundMessages'>[] = [];
		await t.run(async (ctx) => {
			// Seed 65 messages with strictly increasing receivedAt and pre-extract
			// each so the chunk runner takes the skip path (no real LLM call).
			for (let i = 0; i < 65; i++) {
				const msgId = await ctx.db.insert(
					'inboundMessages',
					msgData({ receivedAt: 1000 + i, subject: `msg-${i}` })
				);
				await ctx.db.insert('knowledgeEntries', preExtractedEntry(msgId));
				insertedIds.push(msgId);
			}

			jobId = await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 65,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Run chunk 1 — processes 30 messages, advances cursor to the 30th
		// message's (receivedAt, _id), schedules chunk 2 (which we don't drain).
		await t.action(internal.agent.knowledgeBackfill.runChunk, {
			jobId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			// Job is still running because more chunks remain.
			expect(job!.status).toBe('running');
			expect(job!.scannedCount).toBe(30);
			expect(job!.skippedCount).toBe(30);
			// Cursor advanced to the 30th inserted message (index 29).
			expect(job!.cursorReceivedAt).toBe(1000 + 29);
			expect(job!.cursorId).toBe(insertedIds[29]);
		});
	});

	it('finalizes as completed when last chunk consumes the tail', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);

		let jobId!: Id<'knowledgeBackfillJobs'>;
		const insertedIds: Id<'inboundMessages'>[] = [];
		await t.run(async (ctx) => {
			// Seed 5 messages and pre-extract them, plus a job whose cursor is
			// already past nothing (start). chunkSize=30 picks up all 5 in one go.
			for (let i = 0; i < 5; i++) {
				const msgId = await ctx.db.insert(
					'inboundMessages',
					msgData({ receivedAt: 1000 + i, subject: `tail-${i}` })
				);
				await ctx.db.insert('knowledgeEntries', preExtractedEntry(msgId));
				insertedIds.push(msgId);
			}

			jobId = await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 5,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.action(internal.agent.knowledgeBackfill.runChunk, {
			jobId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('completed');
			expect(job!.scannedCount).toBe(5);
			expect(job!.skippedCount).toBe(5);
			expect(job!.finishedAt).toBeDefined();
		});
	});

	it('nextChunk drains a same-receivedAt group larger than the page', async () => {
		const t = convexTest(schema, modules);
		const ids: Id<'inboundMessages'>[] = [];
		await t.run(async (ctx) => {
			// 5 messages share one receivedAt (the old fixed over-fetch dropped the
			// tail + every later message), then 2 strictly newer.
			for (let i = 0; i < 5; i++) {
				ids.push(await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1000 })));
			}
			ids.push(await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1001 })));
			ids.push(await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1002 })));
		});

		const seen: Id<'inboundMessages'>[] = [];
		let cursorReceivedAt: number | undefined;
		let cursorId: Id<'inboundMessages'> | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await t.query(internal.agent.knowledgeBackfill.nextChunk, {
				cursorReceivedAt,
				cursorId,
				limit: 2,
			});
			for (const m of page.messages) seen.push(m._id);
			if (!page.hasMore) break;
			const last = page.messages[page.messages.length - 1]!;
			cursorReceivedAt = last.receivedAt;
			cursorId = last._id;
		}

		expect(seen).toHaveLength(7); // every message, exactly once
		expect(new Set(seen)).toEqual(new Set(ids));
	});
});

// =====================================================================
// 5. cancel mutation
// =====================================================================

describe('knowledgeBackfill.cancel', () => {
	it('flips a running job to cancelled', async () => {
		const t = convexTest(schema, modules);

		let jobId!: Id<'knowledgeBackfillJobs'>;
		await t.run(async (ctx) => {
			jobId = await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 100,
				scannedCount: 5,
				extractedCount: 4,
				skippedCount: 1,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.withIdentity(testIdentity).mutation(
			api.agent.knowledgeBackfill.cancel,
			{}
		);

		expect(result).toBe(true);

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('cancelled');
			expect(job!.finishedAt).toBeDefined();
		});
	});

	it('writes an agent.backfill_cancelled audit log', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 0,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(
			api.agent.knowledgeBackfill.cancel,
			{}
		);

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'agent.backfill_cancelled'))
				.collect();
			expect(logs.length).toBe(1);
		});
	});

	it('returns false when there is no active job', async () => {
		const t = convexTest(schema, modules);

		const result = await t.withIdentity(testIdentity).mutation(
			api.agent.knowledgeBackfill.cancel,
			{}
		);
		expect(result).toBe(false);
	});

	it('subsequent runChunk on a cancelled job exits cleanly without rescheduling', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);

		let jobId!: Id<'knowledgeBackfillJobs'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('inboundMessages', msgData({ receivedAt: 1000 }));

			jobId = await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'cancelled',
				triggeredBy: 'test',
				totalCount: 1,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				finishedAt: Date.now(),
			});
		});

		// Calling runChunk on a non-running job should return immediately.
		await t.action(internal.agent.knowledgeBackfill.runChunk, {
			jobId,
			chunkSize: 30,
		});

		await t.run(async (ctx) => {
			const job = await ctx.db.get(jobId);
			expect(job!.status).toBe('cancelled');
			expect(job!.scannedCount).toBe(0);
		});
	});

	it('throws when not authenticated', async () => {
		// `cancel` is `adminMutation`; override the default owner stub to mirror
		// the pre-handler rejection an unauthenticated caller would hit.
		sessionMocks.requireAdminContext.mockRejectedValueOnce(new Error('Not authenticated'));
		try {
			const t = convexTest(schema, modules);

			await expect(
				t.mutation(api.agent.knowledgeBackfill.cancel, {})
			).rejects.toThrow('Not authenticated');
		} finally {
			sessionMocks.requireAdminContext.mockResolvedValue({ userId: 'test-user-123', role: 'owner' });
		}
	});
});

// =====================================================================
// 6. getStatus query
// =====================================================================

describe('knowledgeBackfill.getStatus', () => {
	it('returns the most recent job', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'completed',
				triggeredBy: 'old',
				totalCount: 10,
				scannedCount: 10,
				extractedCount: 10,
				skippedCount: 0,
				errorCount: 0,
				startedAt: 1_000,
				updatedAt: 2_000,
				finishedAt: 2_000,
			});
			await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'new',
				totalCount: 20,
				scannedCount: 5,
				extractedCount: 5,
				skippedCount: 0,
				errorCount: 0,
				startedAt: 3_000,
				updatedAt: 3_000,
			});
		});

		const status = await t.withIdentity(testIdentity).query(
			api.agent.knowledgeBackfill.getStatus,
			{}
		);

		expect(status).toBeDefined();
		expect(status!.triggeredBy).toBe('new');
		expect(status!.status).toBe('running');
	});

	it('returns null for non-members (and anonymous)', async () => {
		const { isActiveOrgMember } = await import('../lib/sessionOrganization');
		vi.mocked(isActiveOrgMember).mockResolvedValueOnce(false);
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'x',
				totalCount: 0,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const status = await t.query(api.agent.knowledgeBackfill.getStatus, {});
		expect(status).toBeNull();
	});

	it('returns null when no job exists', async () => {
		const t = convexTest(schema, modules);

		const status = await t.withIdentity(testIdentity).query(
			api.agent.knowledgeBackfill.getStatus,
			{}
		);
		expect(status).toBeNull();
	});
});
