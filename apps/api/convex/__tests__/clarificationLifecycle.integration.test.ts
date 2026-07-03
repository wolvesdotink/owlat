/**
 * Integration tests for the clarification loop's lifecycle plumbing.
 *
 * Covers:
 *   - `inbox.answerClarification` persists the owner's answers onto
 *     `pendingClarification`, drives `awaiting_clarification → drafting`, and
 *     schedules the walker resume.
 *   - `answerClarification` refuses a message that is NOT awaiting clarification.
 *   - The abandoned-question fallback cron
 *     (`processingLifecycle.reconcileAbandonedClarifications`) resumes a message
 *     that sat unanswered past the window, marking it `isAutoSendBlocked` (never
 *     auto-send-eligible) and routing it into `drafting`; a still-fresh await is
 *     left alone.
 *
 * The Agent walker / draft step are excluded from the module glob (they carry
 * `'use node'` + LLM deps), so the scheduled `walker.resumeDraft` is recorded
 * but never executed — these assert the DB-side outcome the mutations own.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createTestInboundMessage } from './factories';

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
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
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
			messageId = await ctx.db.insert('inboundMessages', msgData({
				processingStatus: 'awaiting_clarification',
				classification,
				pendingClarification: pending(1000),
			}));
		});

		const result = await t.withIdentity(testIdentity).mutation(
			api.inbox.mutations.answerClarification,
			{
				inboundMessageId: messageId,
				answers: [{ questionId: 'q1', value: 'A-123' }],
			},
		);
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('drafting');
			expect(msg!.pendingClarification!.answeredAt).toBeDefined();
			const q1 = msg!.pendingClarification!.questions.find((q) => q.id === 'q1');
			const q2 = msg!.pendingClarification!.questions.find((q) => q.id === 'q2');
			expect(q1!.answer!.value).toBe('A-123');
			expect(q1!.answer!.source).toBe('user');
			// Unanswered questions stay unanswered.
			expect(q2!.answer).toBeUndefined();
		});

		// The walker resume was scheduled (the draft re-entry).
		const scheduled = await t.run(async (ctx) => {
			return await ctx.db.system.query('_scheduled_functions').collect();
		});
		expect(
			scheduled.some((s) => s.name.includes('walker') && s.name.includes('resumeDraft')),
		).toBe(true);

		// Audit trail.
		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.clarification_answered'))
				.collect();
			expect(logs.length).toBe(1);
		});
	});

	it('refuses a message that is not awaiting clarification', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({
				processingStatus: 'draft_ready',
				draftResponse: 'hi',
			}));
		});

		await expect(
			t.withIdentity(testIdentity).mutation(api.inbox.mutations.answerClarification, {
				inboundMessageId: messageId,
				answers: [{ questionId: 'q1', value: 'x' }],
			}),
		).rejects.toThrow(/not awaiting clarification/i);
	});

	it('requires authentication', async () => {
		const t = convexTest(schema, modules);
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({
				processingStatus: 'awaiting_clarification',
				pendingClarification: pending(1000),
			}));
		});
		await expect(
			t.mutation(api.inbox.mutations.answerClarification, {
				inboundMessageId: messageId,
				answers: [],
			}),
		).rejects.toThrow('Not authenticated');
	});
});

describe('processingLifecycle.reconcileAbandonedClarifications', () => {
	it('resumes an abandoned await as a non-auto-send-eligible best-guess', async () => {
		const t = convexTest(schema, modules);

		const longAgo = Date.now() - 48 * 60 * 60 * 1000; // 48h ago (> default 24h)
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({
				processingStatus: 'awaiting_clarification',
				classification,
				pendingClarification: pending(longAgo),
			}));
		});

		const { resumed } = await t.mutation(
			internal.inbox.processingLifecycle.reconcileAbandonedClarifications,
			{},
		);
		expect(resumed).toBe(1);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('drafting');
			// Marked so the route step's safety gate can NEVER auto-send it.
			expect(msg!.isAutoSendBlocked).toBe(true);
		});

		const scheduled = await t.run(async (ctx) => {
			return await ctx.db.system.query('_scheduled_functions').collect();
		});
		expect(
			scheduled.some((s) => s.name.includes('walker') && s.name.includes('resumeDraft')),
		).toBe(true);
	});

	it('leaves a still-fresh await untouched', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({
				processingStatus: 'awaiting_clarification',
				classification,
				pendingClarification: pending(Date.now()), // just asked
			}));
		});

		const { resumed } = await t.mutation(
			internal.inbox.processingLifecycle.reconcileAbandonedClarifications,
			{},
		);
		expect(resumed).toBe(0);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('awaiting_clarification');
			expect(msg!.isAutoSendBlocked).toBeUndefined();
		});
	});

	it('respects a shorter configured window (clarificationTimeoutMs)', async () => {
		const t = convexTest(schema, modules);

		const twoMinAgo = Date.now() - 2 * 60 * 1000;
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				clarificationTimeoutMs: 60 * 1000, // 1 minute
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			messageId = await ctx.db.insert('inboundMessages', msgData({
				processingStatus: 'awaiting_clarification',
				classification,
				pendingClarification: pending(twoMinAgo),
			}));
		});

		const { resumed } = await t.mutation(
			internal.inbox.processingLifecycle.reconcileAbandonedClarifications,
			{},
		);
		expect(resumed).toBe(1);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('drafting');
			expect(msg!.isAutoSendBlocked).toBe(true);
		});
	});
});
