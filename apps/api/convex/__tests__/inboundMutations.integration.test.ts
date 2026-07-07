import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	createTestContact,
	createTestInboundMessage,
	createTestConversationThread,
} from './factories';

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

// ============ approveDraft ============

describe('inboundMutations.approveDraft', () => {
	it('should throw when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({ draftResponse: 'A draft' }));
		});

		await expect(
			t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId })
		).rejects.toThrow('Not authenticated');
	});

	it('should approve a draft and set status to approved', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					contactId,
					threadId,
					processingStatus: 'draft_ready',
					draftResponse: 'Thank you for contacting us.',
					draftSubject: 'Re: Support request',
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('approved');
			expect(msg!.processedAt).toBeDefined();

			const thread = await ctx.db.get(threadId);
			expect(thread!.latestDraftStatus).toBe('approved');
		});
	});

	it('should throw when message has no draft', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'received' }));
		});

		await expect(
			t.withIdentity(testIdentity).mutation(api.inbox.mutations.approveDraft, {
				inboundMessageId: messageId,
			})
		).rejects.toThrow('No draft to approve');
	});

	it('should create an audit log', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'draft_ready',
					draftResponse: 'Draft reply',
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.draft_approved'))
				.collect();

			expect(logs.length).toBe(1);
			expect(logs[0]!.userId).toBe('test-user-123');
			expect(logs[0]!.resource).toBe('inbound_message');
		});
	});
});

// ============ rejectDraft ============

describe('inboundMutations.rejectDraft', () => {
	it('should reject a draft and set status to rejected', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					contactId,
					threadId,
					processingStatus: 'draft_ready',
					draftResponse: 'AI-generated draft',
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.rejectDraft, {
				inboundMessageId: messageId,
				reason: 'Tone is too formal',
			});

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('rejected');
			expect(msg!.processedAt).toBeDefined();

			const thread = await ctx.db.get(threadId);
			expect(thread!.latestDraftStatus).toBe('rejected');
		});
	});

	it('should throw when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData());
		});

		await expect(
			t.mutation(api.inbox.mutations.rejectDraft, { inboundMessageId: messageId })
		).rejects.toThrow('Not authenticated');
	});

	it('should create an audit log with reason', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({ processingStatus: 'draft_ready' })
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.rejectDraft, {
				inboundMessageId: messageId,
				reason: 'Inaccurate information',
			});

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.draft_rejected'))
				.collect();

			expect(logs.length).toBe(1);
			expect(logs[0]!.details).toEqual({ reason: 'Inaccurate information' });
		});
	});
});

// ============ editDraft ============

describe('inboundMutations.editDraft', () => {
	it('should update draft response text', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'draft_ready',
					draftResponse: 'Original draft',
					draftSubject: 'Re: Original',
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.editDraft, {
				inboundMessageId: messageId,
				draftResponse: 'Edited draft with better wording',
			});

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.draftResponse).toBe('Edited draft with better wording');
			expect(msg!.draftSubject).toBe('Re: Original');
		});
	});

	it('should update both draft response and subject', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'draft_ready',
					draftResponse: 'Original',
					draftSubject: 'Re: Old Subject',
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.editDraft, {
				inboundMessageId: messageId,
				draftResponse: 'New body',
				draftSubject: 'Re: New Subject',
			});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.draftResponse).toBe('New body');
			expect(msg!.draftSubject).toBe('Re: New Subject');
		});
	});

	it('should throw when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData());
		});

		await expect(
			t.mutation(api.inbox.mutations.editDraft, {
				inboundMessageId: messageId,
				draftResponse: 'test',
			})
		).rejects.toThrow('Not authenticated');
	});

	it('should create an audit log', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({ processingStatus: 'draft_ready' })
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.editDraft, {
				inboundMessageId: messageId,
				draftResponse: 'Edited text',
			});

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.draft_edited'))
				.collect();

			expect(logs.length).toBe(1);
		});
	});
});

// ============ assignThread ============

describe('inboundMutations.assignThread', () => {
	it('should assign a thread to a user', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			// assignThread now validates the assignee against userProfiles.
			await ctx.db.insert('userProfiles', {
				authUserId: 'team-member-42',
				email: 'member42@example.com',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.assignThread, { threadId, assignedTo: 'team-member-42' });

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			expect(thread!.assignedTo).toBe('team-member-42');
		});
	});

	it('should unassign a thread when assignedTo is undefined', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, assignedTo: 'some-user' })
			);
		});

		await t.withIdentity(testIdentity).mutation(api.inbox.mutations.assignThread, { threadId });

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			expect(thread!.assignedTo).toBeUndefined();
		});
	});

	it('should throw when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		await expect(
			t.mutation(api.inbox.mutations.assignThread, { threadId, assignedTo: 'user' })
		).rejects.toThrow('Not authenticated');
	});
});

// ============ assignThread — assignee notification fan-out ============

describe('inboundMutations.assignThread notification', () => {
	it('writes one notice for a cross-user assignment, with subject + assigner name', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, subject: 'Refund request' })
			);
			await ctx.db.insert('userProfiles', {
				authUserId: 'team-member-42',
				email: 'member42@example.com',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			// The assigner's profile supplies the display name on the notice.
			await ctx.db.insert('userProfiles', {
				authUserId: testIdentity.subject,
				email: 'actor@example.com',
				name: 'Actor Admin',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(api.inbox.mutations.assignThread, {
			threadId,
			assignedTo: 'team-member-42',
		});

		await t.run(async (ctx) => {
			const notices = await ctx.db.query('inboxAssignmentNotices').collect();
			expect(notices).toHaveLength(1);
			expect(notices[0]!.userId).toBe('team-member-42');
			expect(notices[0]!.threadId).toBe(threadId);
			expect(notices[0]!.subject).toBe('Refund request');
			expect(notices[0]!.assignedByName).toBe('Actor Admin');
		});
	});

	it('does NOT notify on self-assign', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			// The actor claims the thread for themselves — must exist to pass validation.
			await ctx.db.insert('userProfiles', {
				authUserId: testIdentity.subject,
				email: 'actor@example.com',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.withIdentity(testIdentity).mutation(api.inbox.mutations.assignThread, {
			threadId,
			assignedTo: testIdentity.subject,
		});

		await t.run(async (ctx) => {
			const notices = await ctx.db.query('inboxAssignmentNotices').collect();
			expect(notices).toHaveLength(0);
		});
	});

	it('does NOT notify on unassign', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, assignedTo: 'someone' })
			);
		});

		await t.withIdentity(testIdentity).mutation(api.inbox.mutations.assignThread, { threadId });

		await t.run(async (ctx) => {
			const notices = await ctx.db.query('inboxAssignmentNotices').collect();
			expect(notices).toHaveLength(0);
		});
	});
});

// ============ updateThreadStatus ============

describe('inboundMutations.updateThreadStatus', () => {
	it('should update thread status to resolved', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, status: 'open' })
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.updateThreadStatus, { threadId, status: 'resolved' });

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			expect(thread!.status).toBe('resolved');
		});
	});

	it('should update thread status to closed', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, status: 'open' })
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.updateThreadStatus, { threadId, status: 'closed' });

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			expect(thread!.status).toBe('closed');
		});
	});

	it('should throw when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		await expect(
			t.mutation(api.inbox.mutations.updateThreadStatus, { threadId, status: 'closed' })
		).rejects.toThrow('Not authenticated');
	});
});

// ============ releaseFromQuarantine ============

describe('inboundMutations.releaseFromQuarantine', () => {
	it('should release a quarantined message', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'quarantined',
					securityFlags: {
						injectionDetected: true,
						confidence: 0.7,
						scanTimestamp: Date.now(),
					},
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.releaseFromQuarantine, { inboundMessageId: messageId });

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('received');
			expect(msg!.securityFlags).toBeUndefined();
		});
	});

	it('should throw when message is not quarantined', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'received' }));
		});

		await expect(
			t
				.withIdentity(testIdentity)
				.mutation(api.inbox.mutations.releaseFromQuarantine, { inboundMessageId: messageId })
		).rejects.toThrow('Message is not quarantined');
	});

	it('should create an audit log', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'quarantined',
					securityFlags: {
						injectionDetected: false,
						confidence: 0.3,
						scanTimestamp: Date.now(),
					},
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.releaseFromQuarantine, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.released'))
				.collect();

			expect(logs.length).toBe(1);
			expect(logs[0]!.resource).toBe('inbound_message');
		});
	});
});

// ============ retryFailedMessage ============

describe('inboundMutations.retryFailedMessage', () => {
	it('should re-enqueue a failed message (failed → received, error cleared)', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'failed',
					errorMessage: 'draft step exhausted retries',
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.retryFailedMessage, { inboundMessageId: messageId });

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('received');
			expect(msg!.errorMessage).toBeUndefined();
		});
	});

	it('should reset the most recent failed agentAction to pending', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		let actionId!: Id<'agentActions'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'failed',
					errorMessage: 'boom',
				})
			);
			actionId = await ctx.db.insert('agentActions', {
				inboundMessageId: messageId,
				actionType: 'draft',
				status: 'failed',
				retryCount: 1,
				createdAt: Date.now(),
			});
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.retryFailedMessage, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const action = await ctx.db.get(actionId);
			expect(action!.status).toBe('pending');
		});
	});

	it('should throw when message has not failed', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'received' }));
		});

		await expect(
			t
				.withIdentity(testIdentity)
				.mutation(api.inbox.mutations.retryFailedMessage, { inboundMessageId: messageId })
		).rejects.toThrow('Message has not failed');
	});

	it('should create an audit log', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'failed',
					errorMessage: 'boom',
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.retryFailedMessage, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.retried'))
				.collect();

			expect(logs.length).toBe(1);
			expect(logs[0]!.resource).toBe('inbound_message');
		});
	});
});

// ============ blockSender ============

describe('inboundMutations.blockSender', () => {
	it('should block a sender and archive the message', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Spammer <spammer@evil.com>',
					processingStatus: 'quarantined',
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.blockSender, { inboundMessageId: messageId });

		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('archived');
			expect(msg!.processedAt).toBeDefined();

			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'spammer@evil.com'))
				.first();
			expect(blocked).toBeDefined();
			expect(blocked!.reason).toBe('manual');
		});
	});

	it('should handle from field without angle brackets', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'plainaddr@example.com',
					processingStatus: 'quarantined',
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.blockSender, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'plainaddr@example.com'))
				.first();
			expect(blocked).toBeDefined();
		});
	});

	it('should not create duplicate blocked email entry', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'already@blocked.com',
				reason: 'bounced',
				createdAt: Date.now(),
			});

			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Already <already@blocked.com>',
					processingStatus: 'quarantined',
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.blockSender, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'already@blocked.com'))
				.collect();
			expect(blocked.length).toBe(1);
		});
	});

	it('should create an audit log with email details', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Bad Actor <bad@actor.com>',
				})
			);
		});

		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.blockSender, { inboundMessageId: messageId });

		await t.run(async (ctx) => {
			const logs = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'inbound.sender_blocked'))
				.collect();

			expect(logs.length).toBe(1);
			expect(logs[0]!.details).toEqual({ email: 'bad@actor.com' });
		});
	});
});

// ============ approve → send (sendApprovedReply) ============
//
// Approving a draft schedules `agent.agentPipeline.sendApprovedReply`, which
// must REALLY dispatch the reply through the Send dispatch helper and only
// mark the message `sent` after a successful dispatch. These tests assert the
// outbound artifact (the dispatch call + its params) rather than just the
// approved status, and cover the failure → 'failed' path.

describe('agentPipeline.sendApprovedReply', () => {
	beforeEach(() => {
		enqueueActionMock.mockClear();
	});

	// Approving a draft schedules sendApprovedReply via runAfter(0). It no longer
	// dispatches inline: it enqueues a transactionalSends Send row on the
	// workpool (stubbed here), and completeSend later drives the inbound message
	// to sent/failed (covered in sendCompletion.integration.test.ts). Fake timers
	// + finishAllScheduledFunctions is convex-test's way to drain the scheduled
	// action queue.
	async function approveAndDrain(
		t: ReturnType<typeof convexTest>,
		inboundMessageId: Id<'inboundMessages'>
	) {
		vi.useFakeTimers();
		try {
			await t
				.withIdentity(testIdentity)
				.mutation(api.inbox.mutations.approveDraft, { inboundMessageId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
	}

	async function seedSettings(t: ReturnType<typeof convexTest>) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				defaultFromName: 'Acme Support',
				defaultFromEmail: 'support@acme.test',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
	}

	/** The envelopeInput passed to the most recent transactionalEmailPool enqueue. */
	function lastEnqueuedEnvelope() {
		const calls = enqueueActionMock.mock.calls;
		const call = calls[calls.length - 1];
		return call?.[2]?.envelopeInput;
	}

	it('enqueues an agent_reply Send with the reply body and threading', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		let messageId!: Id<'inboundMessages'>;
		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					contactId,
					threadId,
					from: 'Jane Customer <jane@customer.test>',
					subject: 'Help with my order',
					messageId: '<orig-123@customer.test>',
					references: '<thread-root@customer.test>',
					processingStatus: 'draft_ready',
					draftResponse: 'Hi Jane,\nYour order is on the way.\n\n— Acme',
					draftSubject: 'Re: Help with my order',
				})
			);
		});

		await approveAndDrain(t, messageId);

		// The reply was enqueued on the Send workpool exactly once.
		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		const env = lastEnqueuedEnvelope();
		expect(env.to).toBe('jane@customer.test');
		expect(env.from).toBe('Acme Support <support@acme.test>');
		expect(env.template.subject).toBe('Re: Help with my order');
		expect(env.template.htmlContent).toContain('Your order is on the way.');
		// Threading: In-Reply-To = the inbound message id; References appends it.
		expect(env.headers['In-Reply-To']).toBe('<orig-123@customer.test>');
		expect(env.headers['References']).toBe('<thread-root@customer.test> <orig-123@customer.test>');

		// A queued agent_reply Send row backs the inbound message.
		await t.run(async (ctx) => {
			const sends = await ctx.db.query('transactionalSends').collect();
			const send = sends.find((row) => row.inboundMessageId === messageId);
			expect(send).toBeDefined();
			expect(send!.kind).toBe('agent_reply');
			expect(send!.status).toBe('queued');
			expect(send!.email).toBe('jane@customer.test');
			expect(send!.contactId).toBe(contactId);
		});
	});

	it('marks failed without enqueuing when no sending identity is configured', async () => {
		const t = convexTest(schema, modules);
		// No instanceSettings seeded → no defaultFromEmail.

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Bob <bob@customer.test>',
					processingStatus: 'draft_ready',
					draftResponse: 'Thanks for reaching out.',
					draftSubject: 'Re: question',
				})
			);
		});

		await approveAndDrain(t, messageId);

		// Never enqueued; failed synchronously before reaching the Send model.
		expect(enqueueActionMock).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('failed');
			expect(msg!.errorMessage).toContain('sending identity');
		});
	});

	it('can also be driven directly via the internal action', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'plain@customer.test',
					subject: 'No prefix subject',
					processingStatus: 'approved',
					draftResponse: 'Reply body',
					// No draftSubject → derived "Re: ..." from inbound subject.
				})
			);
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});

		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		const env = lastEnqueuedEnvelope();
		expect(env.to).toBe('plain@customer.test');
		expect(env.template.subject).toBe('Re: No prefix subject');
	});

	// ── Autonomous pre-send reference monitor (autonomous: true) ──────────────
	//
	// The deterministic monitor runs ONLY on the autonomous send path. A clean
	// routine reply to the authenticated sender still enqueues; a draft that
	// would exfiltrate a one-time code fails closed (never enqueued). The
	// human-review path (autonomous omitted) is unaffected.

	it('autonomous: enqueues a clean routine reply to the authenticated sender', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Jane Customer <jane@customer.test>',
					subject: 'Help with my order',
					processingStatus: 'approved',
					draftResponse: 'Hi Jane,\nYour order ships Tuesday.\n\n— Acme',
					draftSubject: 'Re: Help with my order',
				})
			);
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});

		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		expect(lastEnqueuedEnvelope().to).toBe('jane@customer.test');
	});

	it('autonomous: withholds (fails closed, no enqueue) when the draft hands out a one-time code', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Jane Customer <jane@customer.test>',
					subject: 'Access',
					processingStatus: 'approved',
					draftResponse: 'Sure — your verification code is 481920, enter it to sign in.',
					draftSubject: 'Re: Access',
				})
			);
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});

		// Reference monitor withheld the unattended send — nothing enqueued, the
		// message is failed (never sent), and the draft is preserved for review.
		expect(enqueueActionMock).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.processingStatus).toBe('failed');
			expect(msg!.errorMessage).toMatch(/reference monitor/i);
			expect(msg!.draftResponse).toContain('481920'); // draft preserved
		});
	});

	it('human-review path: the monitor does NOT run — the same draft still enqueues', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: 'Jane Customer <jane@customer.test>',
					subject: 'Access',
					processingStatus: 'approved',
					draftResponse: 'Sure — your verification code is 481920, enter it to sign in.',
					draftSubject: 'Re: Access',
				})
			);
		});

		// No `autonomous` flag → human-reviewed send → monitor bypassed.
		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});

		expect(enqueueActionMock).toHaveBeenCalledTimes(1);
		expect(lastEnqueuedEnvelope().to).toBe('jane@customer.test');
	});

	it('dispatches a non-email (sms) reply via the channel adapter, not the email path', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					contactId,
					threadId,
					from: '+15551234567',
					to: 'sms', // processInboundChannel stores the channel literal in `to`
					processingStatus: 'approved',
					draftResponse: 'Thanks! Your order ships today.',
				})
			);
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});

		// No email enqueued — the channel branch schedules channels.dispatchOutbound
		// (a node action, left scheduled here) rather than the MTA path, and does
		// NOT fall through to the old fail-closed behavior for a non-email recipient.
		expect(enqueueActionMock).not.toHaveBeenCalled();
		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg!.processingStatus).toBe('approved'); // dispatchOutbound drives it onward on run
	});

	it('fails a channel reply missing its thread or contact (never reaches the adapter)', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({
					from: '+15559999999',
					to: 'whatsapp',
					processingStatus: 'approved',
					draftResponse: 'hi',
					// no threadId / contactId
				})
			);
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
		});

		expect(enqueueActionMock).not.toHaveBeenCalled();
		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg!.processingStatus).toBe('failed');
	});
});

// ============ receiveMessage blocklist auto-archive ============
//
// Inbound mail from a sender on the `blockedEmails` suppression list must be
// STORE-BUT-SKIP: the inbound path has a hard never-drop invariant (no SMTP 5xx
// rejection), so the message is still persisted, but it is archived on receipt
// via the same lifecycle edge `blockSender` uses and never enters the AI
// classify/route pipeline.

describe('inbound.receiveMessage blocklist auto-archive', () => {
	async function enableAgent(t: ReturnType<typeof convexTest>) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { ai: true, 'ai.agent': true, inbox: true },
				createdAt: Date.now(),
			});
		});
	}

	/** Count scheduled agent-pipeline starts (the only walker.* job receive queues). */
	async function scheduledWalkerStarts(t: ReturnType<typeof convexTest>): Promise<number> {
		return await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query('_scheduled_functions').collect();
			return jobs.filter((j) => (j.name ?? '').includes('walker')).length;
		});
	}

	it('stores and archives inbound mail from a blocklisted sender, skipping AI processing', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'blocked@evil.com',
				reason: 'manual',
				createdAt: Date.now(),
			});
		});

		const r = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Blocked Sender <blocked@evil.com>',
			to: 'inbox@myapp.com',
			subject: 'Buy now',
			textBody: 'spammy content',
			messageId: '<blocked-001@evil.com>',
			timestamp: Date.now(),
		});

		// Nothing dropped: the message is persisted...
		const msg = await t.run(async (ctx) => ctx.db.get(r.inboundMessageId));
		expect(msg).not.toBeNull();
		// ...and archived via the lifecycle...
		expect(msg!.processingStatus).toBe('archived');
		// ...and the AI classify/route pipeline is never scheduled.
		expect(await scheduledWalkerStarts(t)).toBe(0);
	});

	it('normalizes the sender address before the blocklist lookup (case-insensitive)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'blocked@evil.com',
				reason: 'manual',
				createdAt: Date.now(),
			});
		});

		const r = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Blocked <BLOCKED@Evil.com>',
			to: 'inbox@myapp.com',
			subject: 'again',
			messageId: '<blocked-002@evil.com>',
			timestamp: Date.now(),
		});

		const msg = await t.run(async (ctx) => ctx.db.get(r.inboundMessageId));
		expect(msg!.processingStatus).toBe('archived');
		expect(await scheduledWalkerStarts(t)).toBe(0);
	});

	it('leaves ordinary (non-blocklisted) inbound mail untouched — received and AI-processed', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);

		const r = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Real Person <real@example.com>',
			to: 'inbox@myapp.com',
			subject: 'A real question',
			textBody: 'Can you help?',
			messageId: '<real-001@example.com>',
			timestamp: Date.now(),
		});

		const msg = await t.run(async (ctx) => ctx.db.get(r.inboundMessageId));
		expect(msg!.processingStatus).toBe('received');
		expect(await scheduledWalkerStarts(t)).toBe(1);
	});
});
