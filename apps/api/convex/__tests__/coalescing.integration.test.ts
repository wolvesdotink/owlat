import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { COALESCE_MAX_WAIT_MULTIPLIER } from '../agent/coalescing';

/**
 * Message coalescing (agent/coalescing.ts): the per-thread debounce that
 * collapses a burst of inbound messages into a single agent-pipeline run.
 * These exercise the mutation surface directly (no walker run — the scheduled
 * walker.start is a Node action left queued, not flushed).
 */

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') && !path.includes('agentSecurity') && !path.includes('agentContext') &&
		!path.includes('agentClassifier') && !path.includes('agentDrafter') && !path.includes('agentRouter') &&
		!path.includes('agent/walker') && !path.includes('agent/steps/index') && !path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') && !path.includes('agent/steps/draft') &&
		!path.includes('knowledge/extraction') && !path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') && !path.includes('llmProvider'),
	),
);

async function makeThread(t: ReturnType<typeof convexTest>): Promise<Id<'conversationThreads'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('conversationThreads', {
			subject: 'Burst thread',
			normalizedSubject: 'burst thread',
			contactIdentifier: 'burst@example.com',
			status: 'open',
			messageCount: 0,
			firstMessageAt: Date.now(),
			lastMessageAt: Date.now(),
			createdAt: Date.now(),
		}),
	);
}

async function makeMessage(
	t: ReturnType<typeof convexTest>,
	threadId: Id<'conversationThreads'>,
	receivedAt: number,
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `m-${receivedAt}-${Math.random().toString(36).slice(2)}`,
			from: 'burst@example.com',
			to: 'support@owlat.app',
			subject: 'Burst',
			textBody: 'one of several rapid messages',
			threadId,
			processingStatus: 'received',
			receivedAt,
		}),
	);
}

describe('coalescing.shouldCoalesce', () => {
	it('creates exactly one batch and defers processing', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		const m1 = await makeMessage(t, threadId, Date.now());

		const r = await t.mutation(internal.agent.coalescing.shouldCoalesce, {
			threadId,
			messageId: m1,
			coalesceWindowMs: 30_000,
		});
		expect(r.shouldDefer).toBe(true);

		await t.run(async (ctx) => {
			const batches = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect();
			expect(batches).toHaveLength(1);
			expect(batches[0]!.leaderMessageId).toBe(m1);
		});
	});

	it('a second message keeps exactly one batch (debounce restart)', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		const m1 = await makeMessage(t, threadId, Date.now());
		const m2 = await makeMessage(t, threadId, Date.now() + 1);

		await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m1, coalesceWindowMs: 30_000 });
		await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m2, coalesceWindowMs: 30_000 });

		await t.run(async (ctx) => {
			const batches = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect();
			expect(batches).toHaveLength(1);
			// leader advanced to the most recent message
			expect(batches[0]!.leaderMessageId).toBe(m2);
		});
	});

	it('carries the burst start (firstReceivedAt) forward across restarts', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		const m1 = await makeMessage(t, threadId, Date.now());
		const m2 = await makeMessage(t, threadId, Date.now() + 1);

		await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m1, coalesceWindowMs: 30_000 });
		const first = await t.run(async (ctx) => {
			const b = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.first();
			return b!.firstReceivedAt;
		});
		expect(first).toBeTypeOf('number');

		await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m2, coalesceWindowMs: 30_000 });
		await t.run(async (ctx) => {
			const b = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.first();
			// The new row reuses the original burst start, not its own createdAt.
			expect(b!.firstReceivedAt).toBe(first);
		});
	});

	it('hard-caps: a burst open past maxWait flushes immediately instead of deferring', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		const windowMs = 30_000;
		const m1 = await makeMessage(t, threadId, Date.now());

		await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m1, coalesceWindowMs: windowMs });

		// Age the batch so its first message is older than the hard cap, as if the
		// thread had been chattering for the whole maxWait window.
		await t.run(async (ctx) => {
			const b = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.first();
			await ctx.db.patch(b!._id, {
				firstReceivedAt: Date.now() - windowMs * COALESCE_MAX_WAIT_MULTIPLIER - 1,
			});
		});

		const m2 = await makeMessage(t, threadId, Date.now());
		const before = Date.now();
		await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m2, coalesceWindowMs: windowMs });

		await t.run(async (ctx) => {
			const b = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.first();
			const job = await ctx.db.system.get(b!.jobId);
			// Capped → scheduled (near-)immediately, well under a full window ahead.
			expect(job!.scheduledTime).toBeLessThan(before + windowMs);
		});
	});
});

describe('coalescing.processCoalescedBatch', () => {
	it('supersedes older messages (archived/coalesced) and leaves the latest for the pipeline', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		const base = Date.now();
		const older = await makeMessage(t, threadId, base);
		const middle = await makeMessage(t, threadId, base + 1000);
		const latest = await makeMessage(t, threadId, base + 2000);

		// Register all three into the batch window.
		for (const m of [older, middle, latest]) {
			await t.mutation(internal.agent.coalescing.shouldCoalesce, { threadId, messageId: m, coalesceWindowMs: 30_000 });
		}

		await t.mutation(internal.agent.coalescing.processCoalescedBatch, { threadId });

		await t.run(async (ctx) => {
			const o = await ctx.db.get(older);
			const mid = await ctx.db.get(middle);
			const l = await ctx.db.get(latest);
			expect(o!.processingStatus).toBe('archived');
			expect(mid!.processingStatus).toBe('archived');
			// The leader stays 'received' — the walker (scheduled, not flushed here) runs it.
			expect(l!.processingStatus).toBe('received');

			// Batch row consumed.
			const batches = await ctx.db
				.query('coalesceBatches')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect();
			expect(batches).toHaveLength(0);
		});
	});

	it('is a no-op when there are no pending messages', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		// No messages, no batch — must not throw.
		await t.mutation(internal.agent.coalescing.processCoalescedBatch, { threadId });
	});
});
