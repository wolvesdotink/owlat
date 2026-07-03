/**
 * Integration tests for Inbox processing lifecycle (module).
 *
 * Covers the 12-state graph, atomic processingStatus + agentActions writes,
 * latestDraftStatus projection, illegal-edge refusals, terminal-state
 * refusals, the release-from-quarantine and cron-retry reset paths, and
 * the in-state recordStep operations.
 *
 * See docs/adr/0010-inbox-processing-lifecycle-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
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

const securityFlags = {
	injectionDetected: false,
	confidence: 0.1,
	spamScore: 5,
	phishingDetected: false,
	scanTimestamp: Date.now(),
};

const classification = {
	category: 'support',
	priority: 'normal',
	sentiment: 'neutral',
	intent: 'question',
	confidence: 0.9,
};

async function createMessage(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('inboundMessages', {
			messageId: `msg-${Math.random().toString(36).slice(2)}`,
			from: 'sender@example.com',
			to: 'support@owlat.app',
			subject: 'Help please',
			textBody: 'I need help',
			processingStatus: 'received',
			receivedAt: Date.now(),
			...overrides,
		});
	});
}

async function createThread(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'conversationThreads'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('conversationThreads', {
			subject: 'Help please',
			normalizedSubject: 'help please',
			contactIdentifier: 'sender@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
			...overrides,
		});
	});
}

// ============================================================
// transition — happy-path pipeline
// ============================================================

describe('processingLifecycle.transition — pipeline phases', () => {
	it('received → security_check', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'security_check', at: Date.now() },
		});

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.from).toBe('received');
			expect(outcome.to).toBe('security_check');
		}

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('security_check');
		});
	});

	it('security_check → classifying with atomic action completion', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);

		// Step into security_check + begin security_scan action
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'security_check', at: Date.now() },
		});
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'security_scan',
		});

		// Complete security_scan + transition to classifying in one mutation
		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'classifying',
				at: Date.now(),
				completedActionId: actionId,
				securityFlags,
				output: JSON.stringify(securityFlags),
				durationMs: 250,
			},
		});

		expect(outcome.ok).toBe(true);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('classifying');
			expect(m?.securityFlags?.spamScore).toBe(5);
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('completed');
			expect(action?.durationMs).toBe(250);
		});
	});

	it('classifying → drafting stores classification + completes classify action', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'classifying' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'drafting',
				at: Date.now(),
				completedActionId: actionId,
				classification,
				output: JSON.stringify(classification),
				durationMs: 500,
				modelUsed: 'fast',
			},
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('drafting');
			expect(m?.classification?.category).toBe('support');
			expect(m?.confidenceScore).toBe(0.9);
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('completed');
			expect(action?.modelUsed).toBe('fast');
		});
	});

	it('drafting → draft_ready projects latestDraftStatus to pending', async () => {
		const t = convexTest(schema, modules);
		const threadId = await createThread(t);
		const messageId = await createMessage(t, {
			processingStatus: 'drafting',
			threadId,
			draftResponse: 'Thanks for reaching out',
			draftSubject: 'Re: Help please',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'draft_ready',
				at: Date.now(),
			},
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('draft_ready');
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('pending');
		});
	});
});

// ============================================================
// Human review path
// ============================================================

describe('processingLifecycle.transition — human review', () => {
	it('draft_ready → approved projects latestDraftStatus to approved + schedules send', async () => {
		const t = convexTest(schema, modules);
		const threadId = await createThread(t);
		const messageId = await createMessage(t, {
			processingStatus: 'draft_ready',
			threadId,
			draftResponse: 'Thanks',
			draftSubject: 'Re: Help',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: Date.now(), source: 'human', userId: 'user-1' },
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('approved');
			expect(m?.processedAt).toBeDefined();
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('approved');
		});
	});

	it('auto-approve transition increments dailyAutoReplyCount', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: true,
				confidenceThreshold: 0.8,
				dailyAutoReplyCount: 5,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const messageId = await createMessage(t, { processingStatus: 'drafting' });

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: Date.now(), source: 'auto' },
		});

		await t.run(async (ctx) => {
			const configs = await ctx.db.query('agentConfig').take(1);
			// Either incremented (same day) or reset to 1 (new day after midnight).
			expect(configs[0]!.dailyAutoReplyCount).toBeGreaterThanOrEqual(1);
		});
	});

	it('draft_ready → rejected projects latestDraftStatus to rejected', async () => {
		const t = convexTest(schema, modules);
		const threadId = await createThread(t);
		const messageId = await createMessage(t, {
			processingStatus: 'draft_ready',
			threadId,
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'rejected', at: Date.now(), userId: 'user-1', reason: 'Off-topic' },
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('rejected');
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('rejected');
		});
	});

	it('approved → sent projects latestDraftStatus to sent', async () => {
		const t = convexTest(schema, modules);
		const threadId = await createThread(t);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			threadId,
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'sent', at: Date.now() },
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('sent');
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('sent');
		});
	});
});

// ============================================================
// Quarantine / archive / failure
// ============================================================

describe('processingLifecycle.transition — quarantine / archive / failure', () => {
	it('security_check → quarantined stores securityFlags + completes action', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'security_check' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'security_scan',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'quarantined',
				at: Date.now(),
				completedActionId: actionId,
				securityFlags: { ...securityFlags, injectionDetected: true, confidence: 0.9 },
			},
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('quarantined');
			expect(m?.securityFlags?.injectionDetected).toBe(true);
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('completed');
		});
	});

	it('drafting → failed marks the in-flight agentAction as failed', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'drafting' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'draft',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'LLM error',
				failingActionId: actionId,
			},
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('failed');
			expect(m?.errorMessage).toBe('LLM error');
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('failed');
			expect(action?.retryCount).toBe(1);
		});
	});

	it('* → archived works as star-source from draft_ready (block-sender)', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'draft_ready' });

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'archived',
				at: Date.now(),
				reason: 'sender_blocked',
				userId: 'user-1',
			},
		});

		expect(outcome.ok).toBe(true);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('archived');
		});
	});

	it('* → archived from classifying (classifier_spam) completes the running action', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'classifying' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'archived',
				at: Date.now(),
				reason: 'classifier_spam',
				completedActionId: actionId,
				output: '{"category":"spam"}',
			},
		});

		expect(outcome.ok).toBe(true);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('archived');
			expect(m?.processedAt).toBeDefined();
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('completed');
		});
	});

	it('* → archived from security_check (spam) stores securityFlags', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'security_check' });

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'archived',
				at: Date.now(),
				reason: 'spam',
				securityFlags: { ...securityFlags, spamScore: 95 },
			},
		});

		expect(outcome.ok).toBe(true);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('archived');
			expect(m?.securityFlags?.spamScore).toBe(95);
		});
	});

	it('refuses * → archived from terminal states', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'sent' });

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'archived',
				at: Date.now(),
				reason: 'sender_blocked',
			},
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});
});

// ============================================================
// Reset paths
// ============================================================

describe('processingLifecycle.transition — reset paths', () => {
	it('quarantined → received clears securityFlags', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'quarantined',
			securityFlags: { ...securityFlags, injectionDetected: true },
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'received',
				at: Date.now(),
				source: 'release_quarantine',
				userId: 'user-1',
			},
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('received');
			expect(m?.securityFlags).toBeUndefined();
		});
	});

	it('failed → received with resetActionId puts the action back to pending', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'failed' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});
		await t.mutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId,
			errorMessage: 'transient',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'received',
				at: Date.now(),
				source: 'cron_retry',
				resetActionId: actionId,
			},
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('received');
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('pending');
			expect(action?.errorMessage).toBeUndefined();
		});
	});
});

// ============================================================
// Legal-edges refusals
// ============================================================

describe('processingLifecycle.transition — legal-edges enforcement', () => {
	it('refuses received → drafting as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'drafting', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('illegal_edge');
	});

	it('refuses sent → approved as terminal', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'sent' });

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: Date.now(), source: 'human' },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('terminal');
	});

	it('refuses message_not_found for an unknown id', async () => {
		const t = convexTest(schema, modules);
		const fakeId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('inboundMessages', {
				messageId: 'temp',
				from: 'a@b.c',
				to: 'd@e.f',
				subject: 's',
				processingStatus: 'received',
				receivedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: fakeId,
			input: { to: 'security_check', at: Date.now() },
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('message_not_found');
	});
});

// ============================================================
// In-state step recording
// ============================================================

describe('processingLifecycle.recordStep*', () => {
	it('recordStepBegin creates a running agentAction', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);

		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'context_retrieval',
		});

		await t.run(async (ctx) => {
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('running');
			expect(action?.actionType).toBe('context_retrieval');
			expect(action?.retryCount).toBe(0);
		});
	});

	it('recordStepEnd patches the action to completed with output', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});

		await t.mutation(internal.inbox.processingLifecycle.recordStepEnd, {
			actionId,
			output: '{"category":"support"}',
			durationMs: 500,
			modelUsed: 'fast',
		});

		await t.run(async (ctx) => {
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('completed');
			expect(action?.output).toBe('{"category":"support"}');
			expect(action?.durationMs).toBe(500);
		});
	});

	it('recordStepEnd no-ops on a vanished action instead of throwing', async () => {
		// Defense-in-depth: an actionId whose row was deleted (concurrent
		// cleanup, or a stale closure after a retry) must not crash the step —
		// `ctx.db.patch` on a missing id throws. The sibling writers
		// (recordStepFail, the `complete_action` effect) already guard; this
		// asserts recordStepEnd now matches.
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});
		await t.run(async (ctx) => {
			await ctx.db.delete(actionId);
		});

		await expect(
			t.mutation(internal.inbox.processingLifecycle.recordStepEnd, {
				actionId,
				output: 'late',
			})
		).resolves.toBeNull();
	});

	it('recordStepFail marks failed + increments retryCount', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'draft',
		});

		await t.mutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId,
			errorMessage: 'timeout',
		});

		await t.run(async (ctx) => {
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('failed');
			expect(action?.retryCount).toBe(1);
			expect(action?.errorMessage).toBe('timeout');
		});
	});

	it('recordStepFail marks the action terminal (abandoned) once retries are exhausted', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t);
		// Seed a row that has already failed twice (retryCount 2). The third
		// failure lands at retryCount 3 (= MAX_RETRY_ATTEMPTS), which must move it
		// OUT of the retryable `failed` bucket into terminal `abandoned` so the
		// cron's `by_status='failed'` scan is never starved by exhausted rows.
		const actionId = await t.run(async (ctx) => {
			return await ctx.db.insert('agentActions', {
				inboundMessageId: messageId,
				actionType: 'draft',
				status: 'failed',
				retryCount: 2,
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId,
			errorMessage: 'final failure',
		});

		await t.run(async (ctx) => {
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('abandoned');
			expect(action?.retryCount).toBe(3);
		});
	});

	it('recordContextTier stores contextTier without changing status', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'classifying' });

		await t.mutation(internal.inbox.stepOutputs.recordContextTier, {
			inboundMessageId: messageId,
			contextTier: 'compacted',
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.contextTier).toBe('compacted');
			expect(m?.processingStatus).toBe('classifying');
		});
	});

	it('recordDraftOutput stores draft fields without changing status', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'drafting' });

		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: messageId,
			draftResponse: 'Thanks for reaching out',
			draftSubject: 'Re: Help please',
			confidenceScore: 0.9,
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.draftResponse).toBe('Thanks for reaching out');
			expect(m?.draftSubject).toBe('Re: Help please');
			expect(m?.confidenceScore).toBe(0.9);
			expect(m?.processingStatus).toBe('drafting');
		});
	});
});

// ============================================================
// retryFailedActions cron
// ============================================================

describe('processingLifecycle.retryFailedActions', () => {
	it('resets failed actions with retryCount < 3 and brings their messages back to received', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'failed' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});
		await t.mutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId,
			errorMessage: 'first failure',
		});

		await t.mutation(internal.inbox.processingLifecycle.retryFailedActions, {});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('received');
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('pending');
		});
	});

	// Closes ADR-0014 drift bug #6: today's cron-retry resets state to
	// 'received' but no caller re-schedules the pipeline. The lifecycle's
	// `schedule_pipeline_start` effect (added by ADR-0014) now fires on
	// every `to: 'received'` transition and enqueues the Agent walker.
	it('schedules the Agent walker after cron retry resets to received', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'failed' });
		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'classify',
		});
		await t.mutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId,
			errorMessage: 'first failure',
		});

		await t.mutation(internal.inbox.processingLifecycle.retryFailedActions, {});

		const walkerStarts = await t.run(async (ctx) => {
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			return scheduled.filter(
				(j) =>
					j.name.includes('agent/walker') &&
					(j.args[0] as { inboundMessageId?: Id<'inboundMessages'> })?.inboundMessageId ===
						messageId
			);
		});
		expect(walkerStarts.length).toBe(1);
	});

	it('skips actions at max retries (>= 3)', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, { processingStatus: 'failed' });
		const actionId = await t.run(async (ctx) => {
			return await ctx.db.insert('agentActions', {
				inboundMessageId: messageId,
				actionType: 'classify',
				status: 'failed',
				retryCount: 3,
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.inbox.processingLifecycle.retryFailedActions, {});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('failed');
			const action = await ctx.db.get(actionId);
			expect(action?.status).toBe('failed');
		});
	});

	// Regression: a growing head of retry-exhausted rows must NOT starve the
	// cron. Exhausted rows are terminally `abandoned` (not `failed`), so they
	// never enter the `by_status='failed'` scan and a fresh retryable failure
	// is still picked up even behind >20 lifetime-exhausted ones. Under the old
	// single-`failed`-bucket behaviour the ascending take(20) would only ever
	// return the oldest exhausted rows and never reach the fresh one.
	it('picks up a fresh retryable failure even behind >20 exhausted (abandoned) rows', async () => {
		const t = convexTest(schema, modules);

		// 25 lifetime-exhausted rows, each on its own failed message. These are
		// the terminal state recordStepFail now writes once retries run out.
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				const exhaustedMessageId = await ctx.db.insert('inboundMessages', {
					messageId: `exhausted-${i}-${Math.random().toString(36).slice(2)}`,
					from: 'sender@example.com',
					to: 'support@owlat.app',
					subject: 'Help please',
					textBody: 'I need help',
					processingStatus: 'failed',
					receivedAt: Date.now(),
				});
				await ctx.db.insert('agentActions', {
					inboundMessageId: exhaustedMessageId,
					actionType: 'classify',
					status: 'abandoned',
					retryCount: 3,
					createdAt: Date.now() - 1_000_000 + i, // oldest, at the head
				});
			}
		});

		// One fresh, still-retryable failure — created LAST so it is newest.
		const freshMessageId = await createMessage(t, { processingStatus: 'failed' });
		const { actionId: freshActionId } = await t.mutation(
			internal.inbox.processingLifecycle.recordStepBegin,
			{ inboundMessageId: freshMessageId, actionType: 'classify' }
		);
		await t.mutation(internal.inbox.processingLifecycle.recordStepFail, {
			actionId: freshActionId,
			errorMessage: 'fresh transient failure',
		});

		await t.mutation(internal.inbox.processingLifecycle.retryFailedActions, {});

		await t.run(async (ctx) => {
			const fresh = await ctx.db.get(freshMessageId);
			expect(fresh?.processingStatus).toBe('received');
			const freshAction = await ctx.db.get(freshActionId);
			expect(freshAction?.status).toBe('pending');
		});
	});
});

// ============================================================
// reconcileStuckApproved cron — lost send-completion recovery
// ============================================================

describe('processingLifecycle.reconcileStuckApproved', () => {
	const STALE_BEFORE = Date.now() - 20 * 60 * 1000; // older than the 10m threshold

	async function countReEnqueues(
		t: ReturnType<typeof convexTest>,
		messageId: Id<'inboundMessages'>
	) {
		return t.run(async (ctx) => {
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			return scheduled.filter(
				(j) =>
					j.name.includes('agent/agentPipeline') &&
					(j.args[0] as { inboundMessageId?: Id<'inboundMessages'> })?.inboundMessageId ===
						messageId
			).length;
		});
	}

	it('re-enqueues an approved message stuck past the threshold with no queued send', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: STALE_BEFORE,
			draftResponse: 'A reply',
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(1);
		expect(await countReEnqueues(t, messageId)).toBe(1);
	});

	it('leaves an approved message alone while its agent_reply send is still queued', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: STALE_BEFORE,
			draftResponse: 'A reply',
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('transactionalSends', {
				kind: 'agent_reply' as const,
				email: 'sender@example.com',
				inboundMessageId: messageId,
				status: 'queued' as const,
			});
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(0);
		expect(await countReEnqueues(t, messageId)).toBe(0);
	});

	it('ignores recently-approved messages inside the staleness window', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: Date.now(), // just approved
			draftResponse: 'A reply',
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(0);
		expect(await countReEnqueues(t, messageId)).toBe(0);
	});

	it('skips a stale-approved channel reply (sms) — its completion is driven by dispatchOutbound, not a queued send', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: STALE_BEFORE,
			draftResponse: 'A reply',
			to: 'sms', // channel reply — never has a queued transactionalSends row
		});

		// Without the channel skip, this would re-fire sendApprovedReply and
		// re-dispatch the SMS (duplicate), since channel replies never have a
		// queued send to mark them in-flight.
		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(0);
		expect(await countReEnqueues(t, messageId)).toBe(0);
	});
});

// ============================================================
// Configurable send-delay / undo window on autonomous sends
// ============================================================

describe('processingLifecycle — autonomous send-delay / undo window', () => {
	async function setAgentConfig(
		t: ReturnType<typeof convexTest>,
		overrides: Record<string, unknown> = {}
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: true,
				confidenceThreshold: 0.8,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				...overrides,
			});
		});
	}

	async function sendJobsFor(t: ReturnType<typeof convexTest>, messageId: Id<'inboundMessages'>) {
		return t.run(async (ctx) => {
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			return scheduled.filter(
				(j) =>
					j.name.includes('agent/agentPipeline') &&
					(j.args[0] as { inboundMessageId?: Id<'inboundMessages'> })?.inboundMessageId ===
						messageId
			);
		});
	}

	it('auto-approve schedules the send at the configured delay (not 0) and records a cancellable marker', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { autoSendDelayMs: 60_000 });
		const messageId = await createMessage(t, {
			processingStatus: 'drafting',
			draftResponse: 'Auto reply',
		});

		const before = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: before, source: 'auto' },
		});

		// The send is scheduled ~60s out, not immediately.
		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(before + 60_000 - 1_000);

		// A cancellable pending-send marker is persisted for the UI countdown.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.pendingAutoSend).toBeDefined();
			expect(m?.pendingAutoSend?.sendAt).toBeGreaterThanOrEqual(before + 60_000 - 1_000);
			expect(m?.pendingAutoSend?.scheduledFnId).toBeDefined();
		});
	});

	it('defaults to the 60s window when autoSendDelayMs is unset', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t); // no autoSendDelayMs
		const messageId = await createMessage(t, {
			processingStatus: 'drafting',
			draftResponse: 'Auto reply',
		});

		const before = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: before, source: 'auto' },
		});

		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(before + 60_000 - 1_000);
	});

	it('delay=0 preserves legacy behaviour — immediate send, no marker', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { autoSendDelayMs: 0 });
		const messageId = await createMessage(t, {
			processingStatus: 'drafting',
			draftResponse: 'Auto reply',
		});

		const before = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: before, source: 'auto' },
		});

		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		// Immediate: scheduled at (near) now, not a minute out.
		expect(jobs[0]!.scheduledTime).toBeLessThan(before + 5_000);

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.pendingAutoSend).toBeUndefined();
		});
	});

	it('human-reviewed approvals send immediately with no delay/marker', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { autoSendDelayMs: 60_000 });
		const messageId = await createMessage(t, {
			processingStatus: 'draft_ready',
			draftResponse: 'Reviewed reply',
		});

		const before = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: before, source: 'human', userId: 'user-1' },
		});

		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeLessThan(before + 5_000);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.pendingAutoSend).toBeUndefined();
		});
	});

	it('cancelAutoSend before the delay cancels the scheduled send and routes back to human review', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { autoSendDelayMs: 60_000 });
		const threadId = await createThread(t);
		const messageId = await createMessage(t, {
			processingStatus: 'drafting',
			threadId,
			draftResponse: 'Auto reply',
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: Date.now(), source: 'auto' },
		});

		// The delayed send job is live and pending.
		const before = await sendJobsFor(t, messageId);
		expect(before.length).toBe(1);
		expect(before[0]!.state.kind).toBe('pending');

		const result = await t.mutation(internal.inbox.processingLifecycle.cancelAutoSend, {
			inboundMessageId: messageId,
			reason: 'user_cancel',
		});
		expect(result.cancelled).toBe(true);

		// The scheduled send is cancelled (never runs) — no live pending send left.
		const after = await sendJobsFor(t, messageId);
		const stillPending = after.filter((j) => j.state.kind === 'pending');
		expect(stillPending.length).toBe(0);

		// The message is routed back to human review, the marker is cleared.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('draft_ready');
			expect(m?.pendingAutoSend).toBeUndefined();
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('pending');
		});
	});

	it('cancelAutoSend is a no-op when there is no pending send', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: Date.now(),
			draftResponse: 'Auto reply',
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.cancelAutoSend, {
			inboundMessageId: messageId,
			reason: 'kill_switch',
		});
		expect(result.cancelled).toBe(false);
		expect(result.reason).toBe('no_pending_send');
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('approved');
		});
	});

	async function armPendingAutoSend(
		t: ReturnType<typeof convexTest>,
		messageId: Id<'inboundMessages'>,
		sendAt: number
	) {
		await t.run(async (ctx) => {
			const scheduledFnId = await ctx.scheduler.runAfter(
				Math.max(0, sendAt - Date.now()),
				internal.agent.agentPipeline.sendApprovedReply,
				{ inboundMessageId: messageId, autonomous: true }
			);
			await ctx.db.patch(messageId, {
				pendingAutoSend: { scheduledFnId, sendAt, scheduledAt: Date.now() },
			});
		});
	}

	it('reconcile does NOT flag a delayed-but-not-yet-due send as stuck', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			// Approved long ago (would be stale by processedAt alone) …
			processedAt: Date.now() - 30 * 60 * 1000,
			draftResponse: 'Auto reply',
		});
		// … but the delayed send is scheduled in the future.
		await armPendingAutoSend(t, messageId, Date.now() + 60_000);

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(0);
	});

	it('reconcile DOES flag a delayed send whose scheduled time is itself stale (lost completion)', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: Date.now() - 40 * 60 * 1000,
			draftResponse: 'Auto reply',
		});
		// sendAt is 20m in the PAST — past the 10m staleness window.
		await armPendingAutoSend(t, messageId, Date.now() - 20 * 60 * 1000);

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(1);
	});
});

// ============================================================
// cancelAutoSend — kill-switch bulk cancel, race guard, audit
// ============================================================

describe('processingLifecycle — cancelAutoSend safety', () => {
	async function armApprovedPendingSend(
		t: ReturnType<typeof convexTest>,
		overrides: Record<string, unknown> = {}
	): Promise<Id<'inboundMessages'>> {
		const threadId = await createThread(t);
		const messageId = await createMessage(t, {
			processingStatus: 'approved',
			processedAt: Date.now(),
			threadId,
			draftResponse: 'Auto reply',
			...overrides,
		});
		await t.run(async (ctx) => {
			const scheduledFnId = await ctx.scheduler.runAfter(
				60_000,
				internal.agent.agentPipeline.sendApprovedReply,
				{ inboundMessageId: messageId, autonomous: true }
			);
			await ctx.db.patch(messageId, {
				pendingAutoSend: { scheduledFnId, sendAt: Date.now() + 60_000, scheduledAt: Date.now() },
			});
		});
		return messageId;
	}

	it('kill-switch bulk cancel aborts every in-flight autonomous send and routes each to review', async () => {
		const t = convexTest(schema, modules);
		const a = await armApprovedPendingSend(t);
		const b = await armApprovedPendingSend(t);

		const result = await t.mutation(
			internal.inbox.processingLifecycle.cancelPendingAutoSendsForKillSwitch,
			{}
		);
		expect(result.cancelled).toBe(2);

		await t.run(async (ctx) => {
			for (const id of [a, b]) {
				const m = await ctx.db.get(id);
				expect(m?.processingStatus).toBe('draft_ready');
				expect(m?.pendingAutoSend).toBeUndefined();
			}
		});
	});

	it('records an audit entry naming the cancel reason and actor', async () => {
		const t = convexTest(schema, modules);
		const messageId = await armApprovedPendingSend(t);

		await t.mutation(internal.inbox.processingLifecycle.cancelAutoSend, {
			inboundMessageId: messageId,
			reason: 'user_cancel',
			userId: 'user-42',
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			const entry = logs.find((l) => l.action === 'inbound.auto_send_cancelled');
			expect(entry).toBeDefined();
			expect(entry?.userId).toBe('user-42');
			expect(entry?.resourceId).toBe(messageId);
			expect((entry?.details as { reason?: string } | undefined)?.reason).toBe('user_cancel');
		});
	});

	it('system-initiated cancels record under the synthetic system actor', async () => {
		const t = convexTest(schema, modules);
		const messageId = await armApprovedPendingSend(t);

		await t.mutation(internal.inbox.processingLifecycle.cancelAutoSend, {
			inboundMessageId: messageId,
			reason: 'thread_reply',
		});

		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			const entry = logs.find((l) => l.action === 'inbound.auto_send_cancelled');
			expect(entry?.userId).toBe('system');
		});
	});

	it('does NOT cancel once the scheduled send has left the pending queue (enqueue→send race)', async () => {
		const t = convexTest(schema, modules);
		const messageId = await armApprovedPendingSend(t);

		// Simulate the delayed send having already fired: its scheduled function
		// is no longer `pending`. Cancelling here must NOT route an
		// already-dispatched reply back to review.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			await ctx.scheduler.cancel(m!.pendingAutoSend!.scheduledFnId);
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.cancelAutoSend, {
			inboundMessageId: messageId,
			reason: 'thread_reply',
		});
		expect(result.cancelled).toBe(false);
		expect(result.reason).toBe('already_sent');

		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			// Left on the send path — NOT bounced back to review.
			expect(m?.processingStatus).toBe('approved');
		});
	});
});
