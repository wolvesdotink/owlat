import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import {
	createTestContact,
	createTestInboundMessage,
	createTestConversationThread,
	createTestAgentAction,
	enableFeatures,
} from './factories';
import { findOrCreateForEmail, transition } from '../inbox/threads/module';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		// The inbox is admin-only. Resolve role from the test's withIdentity():
		// return null when absent (so the not-authenticated path returns empty)
		// and use the real identity.subject so assignedToMe matching still works.
		getBetterAuthSessionWithRole: vi.fn(async (ctx: QueryCtx) => {
			const identity = await ctx.auth.getUserIdentity();
			if (!identity) return null;
			return { userId: identity.subject, activeOrganizationId: 'org-test', role: 'owner' };
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
			!path.includes('llmProvider')
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

// ============ listThreads ============

describe('inboundQueries.listThreads', () => {
	it('should return empty list when not authenticated', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const result = await t.query(api.inbox.queries.listThreads, {});
		expect(result.threads).toEqual([]);
		expect(result.nextCursor).toBeNull();
	});

	it('should return all threads ordered by lastMessageAt descending', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const now = Date.now();

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, subject: 'Older', lastMessageAt: now - 2000 })
			);
			await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, subject: 'Newer', lastMessageAt: now })
			);
			await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, subject: 'Middle', lastMessageAt: now - 1000 })
			);
		});

		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.listThreads, {});

		expect(result.threads).toHaveLength(3);
		expect(result.threads[0]!.subject).toBe('Newer');
		expect(result.threads[2]!.subject).toBe('Older');
	});

	it('should filter by status', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('conversationThreads', threadData({ contactId, status: 'open' }));
			await ctx.db.insert('conversationThreads', threadData({ contactId, status: 'resolved' }));
			await ctx.db.insert('conversationThreads', threadData({ contactId, status: 'open' }));
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.listThreads, { status: 'open' });

		expect(result.threads).toHaveLength(2);
		expect(result.threads.every((t) => t.status === 'open')).toBe(true);
	});

	it('should respect the limit parameter', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert(
					'conversationThreads',
					threadData({ contactId, lastMessageAt: Date.now() - i * 1000 })
				);
			}
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.listThreads, { limit: 2 });

		expect(result.threads).toHaveLength(2);
	});

	it('should filter by assignedToMe', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, assignedTo: 'test-user-123' })
			);
			await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, assignedTo: 'other-user' })
			);
			await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.listThreads, { assignedToMe: true });

		expect(result.threads).toHaveLength(1);
		expect(result.threads[0]!.assignedTo).toBe('test-user-123');
	});
});

// ============ getThread ============

describe('inboundQueries.getThread', () => {
	it('should return null when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		const result = await t.query(api.inbox.queries.getThread, { threadId });
		expect(result).toBeNull();
	});

	it('should return thread with messages and contact', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'sender@example.com' })
			);
			threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, messageCount: 2 })
			);
			await ctx.db.insert('inboundMessages', msgData({ threadId, contactId, subject: 'First' }));
			await ctx.db.insert('inboundMessages', msgData({ threadId, contactId, subject: 'Second' }));
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.getThread, { threadId });

		expect(result).toBeDefined();
		expect(result!.thread._id).toBe(threadId);
		expect(result!.messages).toHaveLength(2);
		expect(result!.contact).toBeDefined();
		expect(result!.contact!.email).toBe('sender@example.com');
	});

	it('should return null for non-existent thread', async () => {
		const t = convexTest(schema, modules);

		let fakeThreadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const id = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			await ctx.db.delete(id);
			fakeThreadId = id;
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.getThread, { threadId: fakeThreadId });

		expect(result).toBeNull();
	});
});

// ============ getReviewQueue ============

describe('inboundQueries.getReviewQueue', () => {
	it('should return empty array when not authenticated', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.inbox.queries.getReviewQueue, {});
		expect(result).toEqual([]);
	});

	it('should return messages with draft_ready status enriched with thread and contact', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'customer@example.com' })
			);
			const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			// draft_ready message
			await ctx.db.insert(
				'inboundMessages',
				msgData({
					threadId,
					contactId,
					processingStatus: 'draft_ready',
					draftResponse: 'Auto-generated reply',
				})
			);
			// Non-draft_ready message (should be excluded)
			await ctx.db.insert(
				'inboundMessages',
				msgData({
					threadId,
					contactId,
					processingStatus: 'received',
				})
			);
		});

		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.getReviewQueue, {});

		expect(result).toHaveLength(1);
		expect(result[0]!.message.processingStatus).toBe('draft_ready');
		expect(result[0]!.thread).toBeDefined();
		expect(result[0]!.contact).toBeDefined();
		expect(result[0]!.contact!.email).toBe('customer@example.com');
	});

	it('should respect the limit parameter', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert(
					'inboundMessages',
					msgData({
						threadId,
						contactId,
						processingStatus: 'draft_ready',
						draftResponse: `Draft ${i}`,
					})
				);
			}
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.getReviewQueue, { limit: 2 });

		expect(result).toHaveLength(2);
	});
});

// ============ getQuarantined ============

describe('inboundQueries.getQuarantined', () => {
	it('should return empty array when not authenticated', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.inbox.queries.getQuarantined, {});
		expect(result).toEqual([]);
	});

	it('should return quarantined messages', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'quarantined',
					securityFlags: {
						injectionDetected: true,
						confidence: 0.95,
						scanTimestamp: Date.now(),
					},
				})
			);
			await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'received' }));
		});

		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.getQuarantined, {});

		expect(result).toHaveLength(1);
		expect(result[0]!.processingStatus).toBe('quarantined');
	});

	it('should respect the limit parameter', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'quarantined' }));
			}
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.getQuarantined, { limit: 3 });

		expect(result).toHaveLength(3);
	});
});

// ============ getFailed ============

describe('inboundQueries.getFailed', () => {
	it('should return empty array when not authenticated', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.inbox.queries.getFailed, {});
		expect(result).toEqual([]);
	});

	it('should return only failed messages with their error', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'inboundMessages',
				msgData({
					processingStatus: 'failed',
					errorMessage: 'draft step exhausted retries',
				})
			);
			await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'received' }));
			await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'sent' }));
		});

		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.getFailed, {});

		expect(result).toHaveLength(1);
		expect(result[0]!.processingStatus).toBe('failed');
		expect(result[0]!.errorMessage).toBe('draft step exhausted retries');
	});

	it('should respect the limit parameter', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('inboundMessages', msgData({ processingStatus: 'failed' }));
			}
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.getFailed, { limit: 3 });

		expect(result).toHaveLength(3);
	});
});

// ============ getInboundStats ============

describe('inboundQueries.getInboundStats', () => {
	it('should return null when not authenticated', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.inbox.queries.getInboundStats, {});
		expect(result).toBeNull();
	});

	it('should return zero counts when no messages exist', async () => {
		const t = convexTest(schema, modules);

		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.getInboundStats, {});

		expect(result).toBeDefined();
		expect(result!.total).toBe(0);
		expect(result!.received).toBe(0);
		expect(result!.draftReady).toBe(0);
		expect(result!.quarantined).toBe(0);
		expect(result!.openThreads).toBe(0);
	});

	it('should correctly count messages by status', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, status: 'open' })
			);

			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'received' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'received' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'classifying' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'draft_ready', draftResponse: 'draft' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'approved' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'sent' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'quarantined' })
			);
			await ctx.db.insert(
				'inboundMessages',
				msgData({ threadId, contactId, processingStatus: 'failed' })
			);

			// Additional threads
			await ctx.db.insert('conversationThreads', threadData({ contactId, status: 'open' }));
			await ctx.db.insert('conversationThreads', threadData({ contactId, status: 'resolved' }));

			// Pre-seed the denormalized counter doc that the lifecycle / thread
			// module writers maintain in production — direct DB inserts above
			// bypass that path, so `openThreads` reflects the two open threads.
			await ctx.db.insert('instanceSettings', {
				createdAt: Date.now(),
				inboxStats: {
					received: 2,
					processing: 1,
					draftReady: 1,
					approved: 1,
					sent: 1,
					quarantined: 1,
					failed: 1,
					rejected: 0,
					archived: 0,
					total: 8,
				},
				openThreads: 2,
			});
		});

		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.getInboundStats, {});

		expect(result!.total).toBe(8);
		expect(result!.received).toBe(2);
		expect(result!.processing).toBe(1);
		expect(result!.draftReady).toBe(1);
		expect(result!.approved).toBe(1);
		expect(result!.sent).toBe(1);
		expect(result!.quarantined).toBe(1);
		expect(result!.failed).toBe(1);
		expect(result!.openThreads).toBe(2);
	});

	it('reflects the denormalized openThreads counter through create/resolve/reopen', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { createdAt: Date.now(), openThreads: 0 });
		});

		const read = async () => {
			const r = await t.withIdentity(testIdentity).query(api.inbox.queries.getInboundStats, {});
			return r!.openThreads;
		};

		// Create two threads via the production writer (find-or-create).
		const threadId = await t.run(async (ctx) => {
			const a = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'one@example.com',
				subject: 'First',
				normalizedSubject: 'first',
				occurredAt: 1000,
			});
			await findOrCreateForEmail(ctx, {
				contactIdentifier: 'two@example.com',
				subject: 'Second',
				normalizedSubject: 'second',
				occurredAt: 1001,
			});
			return a.threadId;
		});
		expect(await read()).toBe(2);

		// Resolve one → 1.
		await t.run(async (ctx) =>
			transition(ctx, {
				threadId,
				input: { kind: 'status_change', to: 'resolved', source: 'user' },
			})
		);
		expect(await read()).toBe(1);

		// Reopen the resolved thread via inbound activity → 2.
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'inbound_activity', occurredAt: 2000 } })
		);
		expect(await read()).toBe(2);
	});
});

// ============ getMessageActions ============

describe('inboundQueries.getMessageActions', () => {
	it('should return empty array when not authenticated', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData());
		});

		const result = await t.query(api.inbox.queries.getMessageActions, {
			inboundMessageId: messageId,
		});
		expect(result).toEqual([]);
	});

	it('should return agent actions for a message', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert('inboundMessages', msgData());
			await ctx.db.insert(
				'agentActions',
				createTestAgentAction({
					inboundMessageId: messageId,
					actionType: 'security_scan',
					status: 'completed',
				})
			);
			await ctx.db.insert(
				'agentActions',
				createTestAgentAction({
					inboundMessageId: messageId,
					actionType: 'classify',
					status: 'running',
				})
			);
			// Action for different message (should not appear)
			const otherId = await ctx.db.insert('inboundMessages', msgData());
			await ctx.db.insert(
				'agentActions',
				createTestAgentAction({
					inboundMessageId: otherId,
					actionType: 'draft',
					status: 'completed',
				})
			);
		});

		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.getMessageActions, { inboundMessageId: messageId });

		expect(result).toHaveLength(2);
		expect(result.map((a) => a.actionType).sort()).toEqual(['classify', 'security_scan']);
	});
});

// ============ per-user thread reads (unread) ============

describe('inbox.reads.markThreadSeen + listThreads unread', () => {
	it('upserts one read marker per user instead of duplicating rows', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);

		const threadId = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			return await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		await t.withIdentity(testIdentity).mutation(api.inbox.reads.markThreadSeen, { threadId });
		const first = await t.run(async (ctx) =>
			ctx.db
				.query('threadReads')
				.withIndex('by_user_thread', (q) => q.eq('userId', 'test-user').eq('threadId', threadId))
				.collect()
		);
		expect(first).toHaveLength(1);
		const firstSeenAt = first[0]!.lastSeenAt;

		// Re-open advances the timestamp on the SAME row (upsert, not insert).
		await t.withIdentity(testIdentity).mutation(api.inbox.reads.markThreadSeen, { threadId });
		const second = await t.run(async (ctx) =>
			ctx.db
				.query('threadReads')
				.withIndex('by_user_thread', (q) => q.eq('userId', 'test-user').eq('threadId', threadId))
				.collect()
		);
		expect(second).toHaveLength(1);
		expect(second[0]!.lastSeenAt).toBeGreaterThanOrEqual(firstSeenAt);
	});

	it('marks a thread unread until the viewer has seen it, and again after new activity', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const now = Date.now();

		const threadId = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			return await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, lastMessageAt: now })
			);
		});

		// No read marker yet → unread.
		const before = await t.withIdentity(testIdentity).query(api.inbox.queries.listThreads, {});
		expect(before.threads[0]!.unread).toBe(true);

		// Seen after the last message → read. (The list viewer id is the
		// identity subject, so write the marker for that id.)
		await t.run(async (ctx) => {
			await ctx.db.insert('threadReads', {
				threadId,
				userId: testIdentity.subject,
				lastSeenAt: now + 1000,
			});
		});
		const seen = await t.withIdentity(testIdentity).query(api.inbox.queries.listThreads, {});
		expect(seen.threads[0]!.unread).toBe(false);

		// New activity after lastSeen → unread again.
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, { lastMessageAt: now + 5000 });
		});
		const after = await t.withIdentity(testIdentity).query(api.inbox.queries.listThreads, {});
		expect(after.threads[0]!.unread).toBe(true);
	});
});
