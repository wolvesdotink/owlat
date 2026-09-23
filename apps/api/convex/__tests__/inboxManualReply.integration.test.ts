import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	createTestAgentAction,
	createTestContact,
	createTestInboundMessage,
	createTestConversationThread,
} from './factories';
import { MIN_RECEIVED_WAIT_MS, takeOverRefusal, takeOverViewFor } from '../inbox/manualReply';

// The approved agent reply no longer dispatches inline — it enqueues a
// `transactionalSends` Send row on the workpool, and `completeSend` drives the
// inbound message to sent/failed once the worker outcome lands (see ADR + the
// sendCompletion tests). Stub the workpool so `enqueueAction` is a no-op and
// capture the enqueued envelope/context to assert the outbound artifact.
const { enqueueActionMock } = vi.hoisted(() => ({
	enqueueActionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: enqueueActionMock },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	EMAIL_WORKPOOL_RETRY_BEHAVIOR: { maxAttempts: 1 },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		// The inbox is admin-only. Derive identity from the test's withIdentity()
		// so "not authenticated" still throws and the audit userId stays the real
		// identity.subject, while bypassing the (unseeded) betterAuth member lookup.
		getMutationContext: vi.fn(async (ctx: MutationCtx) => {
			const identity = await ctx.auth.getUserIdentity();
			if (!identity) throw new Error('Not authenticated');
			return { userId: identity.subject, role: 'owner' };
		}),
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
			!path.includes('llmProvider') &&
			!path.includes('delivery/workpool')
	)
);

/** Strip fields not in the conversationThreads schema */
function threadData(overrides: Record<string, unknown> = {}) {
	const { updatedAt, channel, ...rest } = createTestConversationThread(overrides);
	return rest;
}

/** Create inbound message data safe for ctx.db.insert (no fake IDs) */
function msgData(overrides: Record<string, unknown> = {}) {
	return createTestInboundMessage({ threadId: undefined, contactId: undefined, ...overrides });
}

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

// Mutation-only tests leave scheduled actions pending. Keep those timers local
// to each test so an earlier approval cannot enqueue during a later assertion.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

/**
 * A person can write the reply the agent will not: with the agent off the
 * pipeline rests in `security_check` after a clean scan, and a failed message
 * rests in `failed`. `takeOverReply` moves either to `draft_ready` so the
 * normal edit → approve path can send a human-written reply.
 */
describe('takeOverRefusal', () => {
	const facts = {
		scanFinished: true,
		agentEnabled: false,
		pipelineStarted: false,
		receivedLongEnough: true,
	};

	it('allows failed, clarification, rejected and archived messages', () => {
		for (const status of ['failed', 'awaiting_clarification', 'rejected', 'archived'] as const) {
			expect(takeOverRefusal(status, facts), status).toBeNull();
		}
	});

	it('allows a finished scan only while the agent is off', () => {
		expect(takeOverRefusal('security_check', facts)).toBeNull();
		expect(takeOverRefusal('security_check', { ...facts, scanFinished: false })).toMatch(
			/security check/
		);
		expect(takeOverRefusal('security_check', { ...facts, agentEnabled: true })).toMatch(/agent/);
	});

	it('allows a received message only when no pipeline run is coming', () => {
		expect(takeOverRefusal('received', facts)).toBeNull();
		expect(takeOverRefusal('received', { ...facts, pipelineStarted: true })).not.toBeNull();
		expect(takeOverRefusal('received', { ...facts, receivedLongEnough: false })).not.toBeNull();
	});

	it('refuses while the agent works and once the reply is out', () => {
		for (const status of ['classifying', 'drafting', 'approved', 'sent', 'quarantined'] as const) {
			expect(takeOverRefusal(status, facts), status).not.toBeNull();
		}
	});
});

describe('manualReply.takeOverReply', () => {
	async function seed(
		t: ReturnType<typeof convexTest>,
		status: string,
		scan?: 'completed' | 'running'
	): Promise<Id<'inboundMessages'>> {
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: status, draftResponse: undefined })
			);
			if (scan) {
				await ctx.db.insert(
					'agentActions',
					createTestAgentAction({ inboundMessageId: messageId, status: scan })
				);
			}
		});
		return messageId;
	}

	it('lets a person write and send the reply when the agent is off', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'security_check', 'completed');
		const asUser = t.withIdentity(testIdentity);

		await asUser.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		await asUser.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: 'Thanks, we have fixed your invoice.',
		});
		const approved = await asUser.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(approved.success).toBe(true);

		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('approved');
		expect(message?.draftResponse).toBe('Thanks, we have fixed your invoice.');
		// A human-written reply carries no fake "agent original".
		expect(message?.draftRevisions?.[0]?.savedBy).toBe('test-user-123');
	});

	it('takes over a failed message', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'failed');
		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('draft_ready');
	});

	it('never answers ahead of an unfinished security scan', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'security_check', 'running');
		await expect(
			t
				.withIdentity(testIdentity)
				.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId })
		).rejects.toThrow(/security check/);
	});

	it('leaves the agent alone while it is drafting', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'drafting');
		await expect(
			t
				.withIdentity(testIdentity)
				.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId })
		).rejects.toThrow();
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('drafting');
	});

	it('refuses a finished scan while the agent is on', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'security_check', 'completed');
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				contactCount: 0,
				createdAt: Date.now(),
				featureFlags: { ai: true, inbox: true, 'ai.agent': true },
			});
		});
		await expect(
			t
				.withIdentity(testIdentity)
				.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId })
		).rejects.toThrow(/agent/);
	});

	it('reopens a rejected draft for a person to answer', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'rejected');
		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('draft_ready');
	});

	it('drops the thrown-out draft when a rejected or archived message is reopened', async () => {
		for (const status of ['rejected', 'archived']) {
			const t = convexTest(schema, modules);
			const messageId = await seed(t, status);
			await t.run(async (ctx) => {
				await ctx.db.patch(messageId, {
					draftResponse: 'The wrong answer the teammate rejected.',
					draftSubject: 'Re: wrong',
				});
			});
			await t
				.withIdentity(testIdentity)
				.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
			const message = await t.run((ctx) => ctx.db.get(messageId));
			expect(message?.processingStatus).toBe('draft_ready');
			expect(message?.draftResponse).toBeUndefined();
			expect(message?.draftSubject).toBeUndefined();
		}
	});

	it('lets a person write the reply instead of answering the agent', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'awaiting_clarification');
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, {
				pendingClarification: {
					questions: [{ id: 'q1', slotType: 'free_text', text: 'Which order?' }],
					askedAt: Date.now(),
				},
			});
		});
		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('draft_ready');
		expect(message?.pendingClarification).toBeUndefined();
	});

	it('never lets a pipeline step skip a clarification straight to draft_ready', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'awaiting_clarification');
		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'draft_ready', at: Date.now(), draftResponse: 'late agent draft' },
		});
		expect(outcome.ok).toBe(false);
	});

	it('hands the composer the same facts the takeover checks', async () => {
		const t = convexTest(schema, modules);
		const scanned = await seed(t, 'security_check', 'completed');
		const scanning = await seed(t, 'security_check', 'running');
		const idle = await seed(t, 'received');
		const view = await t.run(async (ctx) => {
			const rows = await Promise.all([scanned, scanning, idle].map((id) => ctx.db.get(id)));
			return takeOverViewFor(
				ctx,
				rows.filter((r) => r !== null)
			);
		});
		expect(view.receivedWaitMs).toBeGreaterThanOrEqual(MIN_RECEIVED_WAIT_MS);
		const byId = new Map(view.messages.map((m) => [m.messageId, m]));
		expect(byId.get(scanned)).toMatchObject({ scanFinished: true, pipelineStarted: true });
		expect(byId.get(scanning)).toMatchObject({ scanFinished: false, pipelineStarted: true });
		expect(byId.get(idle)).toMatchObject({ scanFinished: false, pipelineStarted: false });
	});

	it('waits out a long follow-up window before a received message can be taken over', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				maxDailyAutoReplies: 100,
				coalesceWindowMs: 10 * 60 * 1000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const view = await t.run((ctx) => takeOverViewFor(ctx, []));
		expect(view.receivedWaitMs).toBe(11 * 60 * 1000);
	});

	it('answers a message the pipeline never picked up, once it has waited', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'received');
		const asUser = t.withIdentity(testIdentity);
		await expect(
			asUser.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId })
		).rejects.toThrow(/still being read/);
		vi.setSystemTime(Date.now() + 10 * 60 * 1000);
		await asUser.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('draft_ready');
	});

	it('never lets a pipeline step reopen an archived message', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'archived');
		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'draft_ready', at: Date.now(), draftResponse: 'late agent draft' },
		});
		expect(outcome.ok).toBe(false);
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('archived');
	});

	it('is a no-op on a message already waiting for a person', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'draft_ready');
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		expect(result.success).toBe(true);
	});
});
