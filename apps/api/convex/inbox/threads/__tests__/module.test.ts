/**
 * Per-kind unit/integration tests for the Conversation thread module.
 *
 * Covers the two intake resolvers (`findOrCreateForEmail`'s three-strategy
 * cascade + `findOrCreateForChannel`'s status-agnostic single strategy), the
 * shared `inbound_activity` reopen + count behaviour, the direct
 * status/assignment/draft-status transitions and their audit rows, and the
 * `thread_not_found` outcome.
 *
 * See docs/adr/0032-conversation-thread-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { createTestContact, createTestConversationThread } from '../../../__tests__/factories';
import { findOrCreateForEmail, findOrCreateForChannel, transition } from '../module';

const allModules = import.meta.glob('../../../**/*.*s');
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Valid conversationThreads row — strips the factory's non-schema fields and
 * its fake `contactId` default (a `testId` string the real validator rejects).
 * A caller that needs a real contactId passes it in `overrides`; it is kept.
 */
function threadData(overrides: Record<string, unknown> = {}) {
	const { channel, updatedAt, contactId, ...rest } =
		createTestConversationThread(overrides);
	void channel;
	void updatedAt;
	return 'contactId' in overrides ? { ...rest, contactId } : rest;
}

/** Minimal inbound message row (only the fields the email matcher reads). */
function inboundMessageData(overrides: Record<string, unknown> = {}) {
	return {
		messageId: 'msg-default',
		from: 'sender@example.com',
		to: 'support@example.com',
		subject: 'Re: hello',
		processingStatus: 'received' as const,
		receivedAt: Date.now(),
		...overrides,
	};
}

/** Collect every audit-log action literal, for asserting the effect fired. */
async function auditActionsFor(
	t: ReturnType<typeof convexTest>,
	threadId: Id<'conversationThreads'>,
) {
	return await t.run(async (ctx) => {
		const rows = await ctx.db.query('auditLogs').collect();
		return rows
			.filter((r) => r.resource === 'conversation_thread' && r.resourceId === threadId)
			.map((r) => ({ action: r.action, details: r.details }));
	});
}

// ─── Email find-or-create ─────────────────────────────────────────────────────

describe('findOrCreateForEmail', () => {
	it('matches by In-Reply-To header (same contact)', async () => {
		const t = convexTest(schema, modules);
		const { threadId, result } = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({
					subject: 'Original',
					normalizedSubject: 'original',
					contactIdentifier: 'sender@example.com',
				}),
			);
			await ctx.db.insert(
				'inboundMessages',
				inboundMessageData({ messageId: 'parent-1', threadId }),
			);
			const result = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'sender@example.com',
				subject: 'Re: Original',
				normalizedSubject: 'original',
				inReplyTo: 'parent-1',
				occurredAt: Date.now(),
			});
			return { threadId, result };
		});
		expect(result.action).toBe('matched');
		expect(result.threadId).toBe(threadId);
	});

	it('falls through to the References header (same contact)', async () => {
		const t = convexTest(schema, modules);
		const { threadId, result } = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ normalizedSubject: 'original', contactIdentifier: 'sender@example.com' }),
			);
			await ctx.db.insert(
				'inboundMessages',
				inboundMessageData({ messageId: 'ref-b', threadId }),
			);
			const result = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'sender@example.com',
				subject: 'Re: Original',
				normalizedSubject: 'original',
				// In-Reply-To misses; the second reference resolves.
				inReplyTo: 'unknown-id',
				references: 'ref-a ref-b',
				occurredAt: Date.now(),
			});
			return { threadId, result };
		});
		expect(result.action).toBe('matched');
		expect(result.threadId).toBe(threadId);
	});

	// Data isolation: RFC 5322 threading headers are attacker-controlled. A
	// forged In-Reply-To / References pointing at ANOTHER contact's thread must
	// NOT splice the inbound into that thread (which would feed the victim's
	// history into the agent draft and reply it back to the attacker).
	it('ignores a forged In-Reply-To that points at another contact thread', async () => {
		const t = convexTest(schema, modules);
		const { victimThreadId, result, newThread } = await t.run(async (ctx) => {
			const victimThreadId = await ctx.db.insert(
				'conversationThreads',
				threadData({
					subject: 'Victim conversation',
					normalizedSubject: 'victim conversation',
					contactIdentifier: 'victim@example.com',
				}),
			);
			await ctx.db.insert(
				'inboundMessages',
				inboundMessageData({ messageId: 'victim-msg-1', threadId: victimThreadId }),
			);
			const result = await findOrCreateForEmail(ctx, {
				// Different sender forging a reference to the victim's message.
				contactIdentifier: 'attacker@evil.com',
				subject: 'Re: Victim conversation',
				normalizedSubject: 'a totally different subject',
				inReplyTo: 'victim-msg-1',
				occurredAt: Date.now(),
			});
			const newThread = await ctx.db.get(result.threadId);
			return { victimThreadId, result, newThread };
		});
		expect(result.action).toBe('created');
		expect(result.threadId).not.toBe(victimThreadId);
		expect(newThread?.contactIdentifier).toBe('attacker@evil.com');
	});

	it('ignores a forged References entry that points at another contact thread', async () => {
		const t = convexTest(schema, modules);
		const { victimThreadId, result } = await t.run(async (ctx) => {
			const victimThreadId = await ctx.db.insert(
				'conversationThreads',
				threadData({
					normalizedSubject: 'victim conversation',
					contactIdentifier: 'victim@example.com',
				}),
			);
			await ctx.db.insert(
				'inboundMessages',
				inboundMessageData({ messageId: 'victim-ref', threadId: victimThreadId }),
			);
			const result = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'attacker@evil.com',
				subject: 'Re: Victim conversation',
				normalizedSubject: 'unrelated subject',
				references: 'bogus-1 victim-ref',
				occurredAt: Date.now(),
			});
			return { victimThreadId, result };
		});
		expect(result.action).toBe('created');
		expect(result.threadId).not.toBe(victimThreadId);
	});

	it('falls through to the normalized-subject + contact composite', async () => {
		const t = convexTest(schema, modules);
		const { threadId, result } = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert(
				'conversationThreads',
				threadData({
					normalizedSubject: 'shipping question',
					contactIdentifier: 'buyer@example.com',
				}),
			);
			const result = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'buyer@example.com',
				subject: 'Re: Shipping question',
				normalizedSubject: 'shipping question',
				occurredAt: Date.now(),
			});
			return { threadId, result };
		});
		expect(result.action).toBe('matched');
		expect(result.threadId).toBe(threadId);
	});

	it('creates a new thread on a full miss', async () => {
		const t = convexTest(schema, modules);
		const { result, thread } = await t.run(async (ctx) => {
			const result = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'brandnew@example.com',
				subject: 'A fresh topic',
				normalizedSubject: 'a fresh topic',
				occurredAt: 1000,
			});
			const thread = await ctx.db.get(result.threadId);
			return { result, thread };
		});
		expect(result.action).toBe('created');
		expect(thread?.contactIdentifier).toBe('brandnew@example.com');
		// Fresh row starts at 0; inbound_activity brings it to exactly 1.
		expect(thread?.messageCount).toBe(1);
		expect(thread?.firstMessageAt).toBe(1000);
		expect(thread?.status).toBe('open');
	});
});

// ─── Channel find-or-create ───────────────────────────────────────────────────

describe('findOrCreateForChannel', () => {
	it('matches the most-recent thread regardless of status (closed is not forked)', async () => {
		const t = convexTest(schema, modules);
		const { closedThreadId, result, thread } = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const closedThreadId = await ctx.db.insert(
				'conversationThreads',
				threadData({ contactId, status: 'closed', messageCount: 4 }),
			);
			const result = await findOrCreateForChannel(ctx, {
				contactId,
				contactIdentifier: '+15551234567',
				subject: 'SMS conversation',
				normalizedSubject: 'sms conversation',
				occurredAt: Date.now(),
			});
			const thread = await ctx.db.get(result.threadId);
			return { closedThreadId, result, thread };
		});
		// Behaviour change (§1): matched + reopened, NOT forked.
		expect(result.action).toBe('matched');
		expect(result.threadId).toBe(closedThreadId);
		expect(thread?.status).toBe('open');
		expect(thread?.messageCount).toBe(5);
	});

	it('creates a new thread when the contact has no history', async () => {
		const t = convexTest(schema, modules);
		const { result, thread } = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const result = await findOrCreateForChannel(ctx, {
				contactId,
				contactIdentifier: '+15559998888',
				subject: 'WHATSAPP conversation',
				normalizedSubject: 'whatsapp conversation',
				occurredAt: 2000,
			});
			const thread = await ctx.db.get(result.threadId);
			return { result, thread };
		});
		expect(result.action).toBe('created');
		expect(thread?.contactIdentifier).toBe('+15559998888');
		expect(thread?.messageCount).toBe(1);
	});
});

// ─── Inbound reopen + count ───────────────────────────────────────────────────

describe('inbound_activity', () => {
	it('reopens a closed thread and emits thread.reopened_by_inbound', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'closed', messageCount: 2 })),
		);

		const outcome = await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'inbound_activity', occurredAt: 9000 } }),
		);
		expect(outcome).toEqual({ ok: true, applied: 'transitioned', threadId });

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.status).toBe('open');
		expect(thread?.messageCount).toBe(3);
		expect(thread?.lastMessageAt).toBe(9000);

		const audits = await auditActionsFor(t, threadId);
		expect(audits.map((a) => a.action)).toContain('thread.reopened_by_inbound');
	});

	it('does not audit when the thread was already open, still increments the count', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'open', messageCount: 7 })),
		);

		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'inbound_activity', occurredAt: 1 } }),
		);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.messageCount).toBe(8);
		expect(thread?.status).toBe('open');

		const audits = await auditActionsFor(t, threadId);
		expect(audits).toHaveLength(0);
	});
});

// ─── Status change ────────────────────────────────────────────────────────────

describe('status_change', () => {
	it('accepts any-to-any and records from/to on the audit row', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'open' })),
		);

		const outcome = await t.run(async (ctx) =>
			transition(ctx, {
				threadId,
				input: { kind: 'status_change', to: 'resolved', source: 'user' },
			}),
		);
		expect(outcome.ok && outcome.applied).toBe('transitioned');

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.status).toBe('resolved');

		const audits = await auditActionsFor(t, threadId);
		const statusAudit = audits.find((a) => a.action === 'thread.status_changed');
		expect(statusAudit?.details).toMatchObject({ from: 'open', to: 'resolved', source: 'user' });
	});

	it('is a no-op (no audit) when the status is unchanged', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'waiting' })),
		);

		const outcome = await t.run(async (ctx) =>
			transition(ctx, {
				threadId,
				input: { kind: 'status_change', to: 'waiting', source: 'user' },
			}),
		);
		expect(outcome.ok && outcome.applied).toBe('noop');
		expect(await auditActionsFor(t, threadId)).toHaveLength(0);
	});
});

// ─── Assignment change ────────────────────────────────────────────────────────

describe('assignment_change', () => {
	it('emits thread.assigned when assigning a user', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData()),
		);

		await t.run(async (ctx) =>
			transition(ctx, {
				threadId,
				input: { kind: 'assignment_change', assignedTo: 'user-42', source: 'user' },
			}),
		);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBe('user-42');

		const audits = await auditActionsFor(t, threadId);
		const assigned = audits.find((a) => a.action === 'thread.assigned');
		expect(assigned?.details).toMatchObject({ userId: 'user-42', source: 'user' });
	});

	it('emits thread.unassigned when clearing the assignee', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ assignedTo: 'user-42' })),
		);

		await t.run(async (ctx) =>
			transition(ctx, {
				threadId,
				input: { kind: 'assignment_change', assignedTo: undefined, source: 'user' },
			}),
		);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.assignedTo).toBeUndefined();

		const audits = await auditActionsFor(t, threadId);
		expect(audits.map((a) => a.action)).toContain('thread.unassigned');
	});
});

// ─── Draft status ──────────────────────────────────────────────────────────────

describe('draft_status_change', () => {
	it('patches latestDraftStatus and records the new value', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData()),
		);

		await t.run(async (ctx) =>
			transition(ctx, {
				threadId,
				input: { kind: 'draft_status_change', latestDraftStatus: 'pending' },
			}),
		);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.latestDraftStatus).toBe('pending');

		const audits = await auditActionsFor(t, threadId);
		const draftAudit = audits.find((a) => a.action === 'thread.draft_status_changed');
		expect(draftAudit?.details).toMatchObject({ latestDraftStatus: 'pending' });
	});
});

// ─── Open-thread counter ──────────────────────────────────────────────────────
//
// The module is the sole writer of `conversationThreads.status`, so it is the
// sole maintainer of the denormalized `instanceSettings.openThreads` counter
// that `getInboundStats` reads instead of collecting the whole open set per
// subscriber. These tests pin the counter exact across every open ↔ non-open
// edge: create-as-open, manual open → {waiting,resolved,closed}, reopen via
// inbound activity, and reopen via a manual status change.

describe('open-thread counter (instanceSettings.openThreads)', () => {
	/** Read the singleton counter, defaulting an unset field to 0. */
	async function openCount(t: ReturnType<typeof convexTest>): Promise<number> {
		return await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			return settings?.openThreads ?? 0;
		});
	}

	/** Seed the singleton settings doc the production writers patch. */
	async function seedSettings(t: ReturnType<typeof convexTest>): Promise<void> {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { createdAt: Date.now(), openThreads: 0 });
		});
	}

	it('increments on create-as-open and decrements when it leaves open', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		// Create-as-open via the email intake resolver.
		const threadId = await t.run(async (ctx) => {
			const { threadId } = await findOrCreateForEmail(ctx, {
				contactIdentifier: 'a@example.com',
				subject: 'Help',
				normalizedSubject: 'help',
				occurredAt: 1000,
			});
			return threadId;
		});
		expect(await openCount(t)).toBe(1);

		// open → resolved decrements.
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'resolved', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(0);
	});

	it('stays exact across waiting / resolved / closed and reopen cycles', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'open' })),
		);
		// Direct insert above bypasses the module — seed the counter to match.
		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			if (s) await ctx.db.patch(s._id, { openThreads: 1 });
		});

		// open → waiting (-1)
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'waiting', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(0);

		// waiting → resolved (non-open → non-open: no change)
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'resolved', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(0);

		// resolved → open via manual reopen (+1)
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'open', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(1);

		// open → closed (-1)
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'closed', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(0);

		// closed → open via inbound activity reopen (+1)
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'inbound_activity', occurredAt: 2000 } }),
		);
		expect(await openCount(t)).toBe(1);
	});

	it('does not double-count a no-op status change or inbound to an open thread', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'open' })),
		);
		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			if (s) await ctx.db.patch(s._id, { openThreads: 1 });
		});

		// status_change open → open is a NOOP (no patch) — counter unchanged.
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'open', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(1);

		// inbound_activity on an already-open thread does not re-bump.
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'inbound_activity', occurredAt: 3000 } }),
		);
		expect(await openCount(t)).toBe(1);
	});

	it('does not bump on a matched (not created) intake', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);

		// Seed an existing open thread + matching counter.
		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({
				normalizedSubject: 'shipping',
				contactIdentifier: 'buyer@example.com',
				status: 'open',
			})),
		);
		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			if (s) await ctx.db.patch(s._id, { openThreads: 1 });
		});

		// A match (not a create) must not bump the counter.
		const result = await t.run(async (ctx) =>
			findOrCreateForEmail(ctx, {
				contactIdentifier: 'buyer@example.com',
				subject: 'Re: shipping',
				normalizedSubject: 'shipping',
				occurredAt: 4000,
			}),
		);
		expect(result.action).toBe('matched');
		expect(result.threadId).toBe(threadId);
		expect(await openCount(t)).toBe(1);
	});

	it('clamps at zero rather than going negative', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t); // openThreads starts at 0

		const threadId = await t.run(async (ctx) =>
			ctx.db.insert('conversationThreads', threadData({ status: 'open' })),
		);
		// Counter intentionally left at 0 (desync) — leaving open clamps, not -1.
		await t.run(async (ctx) =>
			transition(ctx, { threadId, input: { kind: 'status_change', to: 'closed', source: 'user' } }),
		);
		expect(await openCount(t)).toBe(0);
	});
});

// ─── thread_not_found ─────────────────────────────────────────────────────────

describe('transition on a missing thread', () => {
	it('returns { ok: false, reason: thread_not_found }', async () => {
		const t = convexTest(schema, modules);
		const outcome = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert(
				'conversationThreads',
				threadData(),
			);
			await ctx.db.delete(threadId);
			return transition(ctx, {
				threadId,
				input: { kind: 'status_change', to: 'closed', source: 'user' },
			});
		});
		expect(outcome).toEqual({ ok: false, reason: 'thread_not_found' });
	});
});
