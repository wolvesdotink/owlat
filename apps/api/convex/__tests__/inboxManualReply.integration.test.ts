import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	createTestAgentAction,
	createTestContact,
	createTestInboundMessage,
	createTestConversationThread,
} from './factories';
import { takeOverRefusal } from '../inbox/manualReply';

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
	it('allows failed messages and finished scans, nothing else', () => {
		expect(takeOverRefusal('failed', false)).toBeNull();
		expect(takeOverRefusal('security_check', true)).toBeNull();
		expect(takeOverRefusal('security_check', false)).toMatch(/security check/);
		for (const status of ['received', 'classifying', 'drafting', 'sent', 'archived'] as const) {
			expect(takeOverRefusal(status, true), status).not.toBeNull();
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

	it('is a no-op on a message already waiting for a person', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seed(t, 'draft_ready');
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });
		expect(result.success).toBe(true);
	});
});
