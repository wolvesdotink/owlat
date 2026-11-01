/**
 * Integration tests for the clarification loop's lifecycle plumbing.
 *
 * Covers:
 *   - `inbox.answerClarification` persists the owner's answers onto
 *     `pendingClarification`, drives `awaiting_clarification → drafting`, and
 *     schedules the walker resume.
 *   - `answerClarification` refuses a message that is NOT awaiting clarification,
 *     and refuses to leave a question open unless the owner chose "Draft with
 *     what I have" (`withGaps`, stored as `isGapsAccepted`).
 *   - The abandoned-question cron
 *     (`processingLifecycle.reconcileAbandonedClarifications`) asks again, once,
 *     about a message that sat unanswered past the window. It drafts nothing:
 *     the message keeps waiting in `awaiting_clarification`; a still-fresh await
 *     is left alone.
 *
 * The Agent walker / draft step are excluded from the module glob (they carry
 * `'use node'` + LLM deps), so the scheduled `walker.resumeDraft` is recorded
 * but never executed — these assert the DB-side outcome the mutations own.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createTestInboundMessage } from './factories';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import { pushHarness } from '../push/__tests__/pushFixtures';

// The flow under test schedules the functions below, which this suite's
// module map leaves out (or which need a setup it does not make). Their jobs
// fail when they fire, often after the test that scheduled them. These tests
// are not about them.
beforeEach(() => {
	expectScheduledFailure('agent/walker:resumeDraft');
	expectScheduledFailure('agent/walker:start');
});

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getMutationContext: vi.fn(async (ctx: MutationCtx) => {
			const identity = await ctx.auth.getUserIdentity();
			if (!identity) throw new Error('Not authenticated');
			return { userId: identity.subject, role: 'owner' };
		}),
		// `answerClarification` is an adminMutation, so its wrapper calls
		// requireAdminContext(ctx). Mock it too (mirroring
		// inboundMutations.integration.test.ts) so the handler is actually
		// reached and the persist + transition + resume are exercised.
		requireAdminContext: vi.fn(async (ctx: MutationCtx) => {
			const identity = await ctx.auth.getUserIdentity();
			if (!identity) throw new Error('Not authenticated');
			return { userId: identity.subject, role: 'owner' };
		}),
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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

function msgData(overrides: Record<string, unknown> = {}) {
	return createTestInboundMessage({ threadId: undefined, contactId: undefined, ...overrides });
}

const classification = {
	category: 'support',
	priority: 'normal',
	sentiment: 'neutral',
	intent: 'question',
	confidence: 0.8,
};

function pending(askedAt: number) {
	return {
		questions: [
			{ id: 'q1', slotType: 'order_number', text: 'What is your order number?' },
			{ id: 'q2', slotType: 'free_text', text: 'Anything else?' },
		],
		askedAt,
	};
}

describe('inbox.answerClarification', () => {
	it('persists answers, transitions to drafting, and schedules the resume', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'awaiting_clarification',
					classification,
					pendingClarification: pending(1000),
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.clarification.answerClarification, {
				inboundMessageId: messageId,
				answers: [
					{ questionId: 'q1', value: 'A-123' },
					{ questionId: 'q2', value: 'No' },
				],
			});
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('drafting');
			expect(msg!.pendingClarification!.answeredAt).toBeDefined();
			expect(msg!.pendingClarification!.isGapsAccepted).toBeUndefined();
			const q1 = msg!.pendingClarification!.questions.find((q) => q.id === 'q1');
			expect(q1!.answer!.value).toBe('A-123');
			expect(q1!.answer!.source).toBe('user');
		});

		// The walker resume was scheduled (the draft re-entry).
		const scheduled = await t.run(async (ctx) => {
			return await ctx.db.system.query('_scheduled_functions').collect();
		});
		expect(scheduled.some((s) => s.name.includes('walker') && s.name.includes('resumeDraft'))).toBe(
			true
		);

		// Audit trail.
		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.clarification_answered'))
				.collect();
			expect(logs.length).toBe(1);
		});
	});

	it('refuses to leave a question open without "Draft with what I have"', async () => {
		const t = convexTest(schema, modules);
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'awaiting_clarification',
					classification,
					pendingClarification: pending(1000),
				})
			);
		});

		for (const value of [undefined, '   ']) {
			await expect(
				t.withIdentity(testIdentity).mutation(api.inbox.clarification.answerClarification, {
					inboundMessageId: messageId,
					answers: [
						{ questionId: 'q1', value: 'A-123' },
						...(value === undefined ? [] : [{ questionId: 'q2', value }]),
					],
				})
			).rejects.toThrow(/answer every question/i);
		}

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('awaiting_clarification');
			expect(msg!.pendingClarification!.questions.every((q) => !q.answer)).toBe(true);
		});
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled.some((s) => s.name.includes('resumeDraft'))).toBe(false);
	});

	it('drafts with a question left open once the owner agrees to gaps', async () => {
		const t = convexTest(schema, modules);
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'awaiting_clarification',
					classification,
					pendingClarification: pending(1000),
				})
			);
		});

		await t.withIdentity(testIdentity).mutation(api.inbox.clarification.answerClarification, {
			inboundMessageId: messageId,
			answers: [{ questionId: 'q1', value: 'A-123' }],
			withGaps: true,
		});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('drafting');
			expect(msg!.pendingClarification!.isGapsAccepted).toBe(true);
			const q2 = msg!.pendingClarification!.questions.find((q) => q.id === 'q2');
			expect(q2!.answer).toBeUndefined();
		});
	});

	// The draft step reads the consent and the open question back from here on
	// the retry (agent/steps/draft/__tests__/gapHold.test.ts), so a provider
	// failure after "Draft with what I have" must not lose them.
	it('keeps "Draft with what I have" across a failed draft and its retry', async () => {
		const t = convexTest(schema, modules);
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'awaiting_clarification',
					classification,
					pendingClarification: pending(1000),
				})
			);
		});
		await t.withIdentity(testIdentity).mutation(api.inbox.clarification.answerClarification, {
			inboundMessageId: messageId,
			answers: [{ questionId: 'q1', value: 'A-123' }],
			withGaps: true,
		});

		const { actionId } = await t.mutation(internal.inbox.processingLifecycle.recordStepBegin, {
			inboundMessageId: messageId,
			actionType: 'draft',
		});
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'provider down',
				failingActionId: actionId,
			},
		});
		await t.mutation(internal.inbox.processingLifecycle.retryFailedActions, {});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('received');
			expect(msg!.pendingClarification!.isGapsAccepted).toBe(true);
			const q2 = msg!.pendingClarification!.questions.find((q) => q.id === 'q2');
			expect(q2!.answer).toBeUndefined();
		});
	});

	it('refuses a message that is not awaiting clarification', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'draft_ready',
					draftResponse: 'hi',
				})
			);
		});

		await expect(
			t.withIdentity(testIdentity).mutation(api.inbox.clarification.answerClarification, {
				inboundMessageId: messageId,
				answers: [{ questionId: 'q1', value: 'x' }],
			})
		).rejects.toThrow(/not awaiting clarification/i);
	});

	it('requires authentication', async () => {
		const t = convexTest(schema, modules);
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'awaiting_clarification',
					pendingClarification: pending(1000),
				})
			);
		});
		await expect(
			t.mutation(api.inbox.clarification.answerClarification, {
				inboundMessageId: messageId,
				answers: [],
			})
		).rejects.toThrow('Not authenticated');
	});
});

describe('processingLifecycle.reconcileAbandonedClarifications', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** One cron run with its reminder chain (scheduled); the reminder notices it sent. */
	async function remindRun(t: ReturnType<typeof convexTest>): Promise<number> {
		const count = () =>
			t.run(async (ctx) =>
				(await ctx.db.query('inboxAssignmentNotices').collect()).filter((n) => n.isReminder)
			);
		const before = (await count()).length;
		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		return (await count()).length - before;
	}

	// On a conversation, with shared-inbox readers to ask (pushHarness seeds
	// two admins): the reminder notifies them.
	async function seedAwaiting(t: ReturnType<typeof convexTest>, askedAt: number) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Order',
				normalizedSubject: 'order',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			return ctx.db.insert(
				'inboundMessages',
				msgData({
					threadId,
					processingStatus: 'awaiting_clarification',
					classification,
					pendingClarification: pending(askedAt),
				})
			);
		});
	}

	it('asks an abandoned await again, once, and drafts nothing', async () => {
		const t = await pushHarness(modules);
		const messageId = await seedAwaiting(t, Date.now() - 48 * 60 * 60 * 1000);

		// Both shared-inbox readers, once.
		expect(await remindRun(t)).toBe(2);
		expect(await remindRun(t)).toBe(0);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			// Still waiting on the owner: no best-guess draft around the questions.
			expect(msg!.processingStatus).toBe('awaiting_clarification');
			expect(msg!.pendingClarification!.remindedAt).toBeDefined();
			expect(msg!.draftResponse).toBeUndefined();
		});
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled.some((s) => s.name.includes('resumeDraft'))).toBe(false);
	});

	it('leaves a still-fresh await untouched', async () => {
		const t = await pushHarness(modules);
		const messageId = await seedAwaiting(t, Date.now());

		expect(await remindRun(t)).toBe(0);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('awaiting_clarification');
			expect(msg!.pendingClarification!.remindedAt).toBeUndefined();
		});
	});

	it('respects a shorter configured window (clarificationTimeoutMs)', async () => {
		const t = await pushHarness(modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				clarificationTimeoutMs: 60 * 1000, // 1 minute
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const messageId = await seedAwaiting(t, Date.now() - 2 * 60 * 1000);

		expect(await remindRun(t)).toBe(2);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('awaiting_clarification');
			expect(msg!.pendingClarification!.remindedAt).toBeDefined();
		});
	});
});
