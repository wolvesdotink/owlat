/**
 * Server-side collision soft-hold predicate (UX piece b3b).
 *
 * `getActiveReplierOtherThan` is the double-check `inbox.mutations.approveDraft`
 * runs at send time: it returns the OTHER teammate actively replying to a thread
 * (so the mutation returns a soft `reply_in_progress` error instead of quietly
 * double-answering), and `null` when nobody else is replying (viewers don't
 * hold, and your own `replying` row never holds your own send).
 *
 * Driven through `t.run` so the predicate is exercised against real presence
 * rows without standing up the full admin-mutation auth + send pipeline.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { getActiveReplierOtherThan, PRESENCE_ACTIVE_WINDOW_MS } from '../presence';

const allModules = import.meta.glob('../../**/*.*s');
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

const ME = 'user_me';
const OTHER = 'user_other';

async function makeThread(t: ReturnType<typeof convexTest>): Promise<Id<'conversationThreads'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('conversationThreads', {
			subject: 'Refund request',
			normalizedSubject: 'refund request',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});
}

describe('getActiveReplierOtherThan', () => {
	it('returns the other teammate when they are actively replying', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('threadPresence', {
				threadId,
				userId: OTHER,
				mode: 'replying',
				heartbeatAt: Date.now(),
			});
		});

		const result = await t.run((ctx) => getActiveReplierOtherThan(ctx, threadId, ME));
		expect(result).toEqual({ userId: OTHER });
	});

	it('allows (returns null) when the other teammate is only viewing', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('threadPresence', {
				threadId,
				userId: OTHER,
				mode: 'viewing',
				heartbeatAt: Date.now(),
			});
		});

		const result = await t.run((ctx) => getActiveReplierOtherThan(ctx, threadId, ME));
		expect(result).toBeNull();
	});

	it('never holds on your OWN replying presence', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('threadPresence', {
				threadId,
				userId: ME,
				mode: 'replying',
				heartbeatAt: Date.now(),
			});
		});

		const result = await t.run((ctx) => getActiveReplierOtherThan(ctx, threadId, ME));
		expect(result).toBeNull();
	});

	it('ignores a stale replying row past the active window', async () => {
		const t = convexTest(schema, modules);
		const threadId = await makeThread(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('threadPresence', {
				threadId,
				userId: OTHER,
				mode: 'replying',
				// Older than the active window — the teammate has gone; hold releases.
				heartbeatAt: Date.now() - PRESENCE_ACTIVE_WINDOW_MS - 1_000,
			});
		});

		const result = await t.run((ctx) => getActiveReplierOtherThan(ctx, threadId, ME));
		expect(result).toBeNull();
	});
});
