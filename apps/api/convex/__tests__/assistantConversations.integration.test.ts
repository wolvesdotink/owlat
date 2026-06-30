import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { enableFeatures } from './factories';

const modules = import.meta.glob('../**/*.*s');

function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

/**
 * Personal AI assistant — conversation data plane (owner-scoped CRUD, the
 * send/stream lifecycle's DB effects, and the runner's internal patch/finalize
 * mutations). The runner action itself is covered in assistantRunner with a
 * mocked LLM; here we exercise the mutations/queries it sits on.
 */

const sess = vi.hoisted(() => ({ user: { userId: 'user-a', role: 'owner' as const } }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization',
	);
	return {
		...actual,
		requireOrgMember: vi.fn(async () => sess.user),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => sess.user.userId),
		getMutationContext: vi.fn(async () => sess.user),
	};
});

beforeEach(() => {
	sess.user = { userId: 'user-a', role: 'owner' };
});

describe('assistant conversations — feature gating', () => {
	it('refuses every entry point when ai.assistant is off', async () => {
		const t = makeT();
		await expect(t.mutation(api.assistant.conversations.createConversation, {})).rejects.toThrow();
		await expect(t.query(api.assistant.conversations.listConversations, {})).rejects.toThrow();
	});
});

describe('assistant conversations — CRUD + ownership', () => {
	it('creates, lists, renames, and soft-deletes a conversation', async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);

		const id = await t.mutation(api.assistant.conversations.createConversation, {});
		let list = await t.query(api.assistant.conversations.listConversations, {});
		expect(list.map((c) => c._id)).toContain(id);
		expect(list.find((c) => c._id === id)?.title).toBe('New conversation');

		await t.mutation(api.assistant.conversations.renameConversation, {
			conversationId: id,
			title: 'My questions',
		});
		list = await t.query(api.assistant.conversations.listConversations, {});
		expect(list.find((c) => c._id === id)?.title).toBe('My questions');

		await t.mutation(api.assistant.conversations.deleteConversation, { conversationId: id });
		list = await t.query(api.assistant.conversations.listConversations, {});
		expect(list.map((c) => c._id)).not.toContain(id);
	});

	it("hides another member's conversation and its messages", async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);

		const id = await t.mutation(api.assistant.conversations.createConversation, {});
		await t.mutation(api.assistant.conversations.sendMessage, {
			conversationId: id,
			text: 'private question',
		});

		// Switch to a different member — they must not see it.
		sess.user = { userId: 'user-b', role: 'owner' };
		const list = await t.query(api.assistant.conversations.listConversations, {});
		expect(list.map((c) => c._id)).not.toContain(id);
		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId: id });
		expect(msgs).toEqual([]);
		await expect(
			t.mutation(api.assistant.conversations.renameConversation, { conversationId: id, title: 'x' }),
		).rejects.toThrow();
	});
});

describe('assistant conversations — send lifecycle', () => {
	it('inserts the user turn + a streaming assistant placeholder and titles the conversation', async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);

		const id = await t.mutation(api.assistant.conversations.createConversation, {});
		const { assistantMessageId } = await t.mutation(api.assistant.conversations.sendMessage, {
			conversationId: id,
			text: 'What was the open rate of the welcome campaign?',
		});

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId: id });
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toMatchObject({ role: 'user', status: 'complete' });
		expect(msgs[0]?.text).toContain('open rate');
		expect(msgs[1]).toMatchObject({ role: 'assistant', status: 'streaming', text: '' });
		expect(msgs[1]?._id).toBe(assistantMessageId);

		// First user message becomes the title.
		const list = await t.query(api.assistant.conversations.listConversations, {});
		expect(list.find((c) => c._id === id)?.title).toContain('open rate');
		expect(list.find((c) => c._id === id)?.messageCount).toBe(2);
	});

	it('rejects empty messages', async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);
		const id = await t.mutation(api.assistant.conversations.createConversation, {});
		await expect(
			t.mutation(api.assistant.conversations.sendMessage, { conversationId: id, text: '   ' }),
		).rejects.toThrow();
	});

	it('listMessages returns the NEWEST messages (chronological) past the 500 cap', async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);

		// Seed a conversation owned by the mocked user with 501 messages, so the
		// 500-row window must drop the oldest, not the newest.
		const id = await t.run(async (ctx) => {
			const now = Date.now();
			const convoId = await ctx.db.insert('aiConversations', {
				ownerId: 'user-a', title: 'Long', createdAt: now, updatedAt: now,
				lastMessageAt: now, messageCount: 501,
			});
			for (let i = 0; i < 501; i++) {
				await ctx.db.insert('aiMessages', {
					conversationId: convoId, ownerId: 'user-a', role: 'user',
					text: `m${i}`, status: 'complete', createdAt: now + i,
				});
			}
			return convoId;
		});

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId: id });
		expect(msgs).toHaveLength(500);
		// Newest is present, oldest dropped, and order is chronological ascending.
		expect(msgs[0]?.text).toBe('m1');
		expect(msgs[msgs.length - 1]?.text).toBe('m500');
	});
});

describe('assistant conversations — runner internal mutations', () => {
	it('patches streaming text and signals stop once finalized', async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);
		const id = await t.mutation(api.assistant.conversations.createConversation, {});
		const { assistantMessageId } = await t.mutation(api.assistant.conversations.sendMessage, {
			conversationId: id,
			text: 'hi',
		});

		const r1 = await t.mutation(internal.assistant.conversations.patchAssistantMessage, {
			messageId: assistantMessageId,
			text: 'partial…',
		});
		expect(r1.stop).toBe(false);

		await t.mutation(internal.assistant.conversations.finalizeAssistantMessage, {
			messageId: assistantMessageId,
			text: 'final answer',
			status: 'complete',
			model: 'test-model',
			tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
		});

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId: id });
		const assistant = msgs.find((m) => m._id === assistantMessageId);
		expect(assistant).toMatchObject({ status: 'complete', text: 'final answer', model: 'test-model' });

		// After finalization the row is no longer streaming → patch signals stop.
		const r2 = await t.mutation(internal.assistant.conversations.patchAssistantMessage, {
			messageId: assistantMessageId,
			text: 'late delta',
		});
		expect(r2.stop).toBe(true);
	});

	it('preserves a user Stop over the runner finishing complete', async () => {
		const t = makeT();
		await enableFeatures(t, ['ai.assistant']);
		const id = await t.mutation(api.assistant.conversations.createConversation, {});
		const { assistantMessageId } = await t.mutation(api.assistant.conversations.sendMessage, {
			conversationId: id,
			text: 'hi',
		});

		await t.mutation(api.assistant.conversations.stopGeneration, { messageId: assistantMessageId });
		// Runner tries to finish 'complete' afterwards — the user's 'stopped' wins.
		await t.mutation(internal.assistant.conversations.finalizeAssistantMessage, {
			messageId: assistantMessageId,
			text: 'whatever streamed so far',
			status: 'complete',
		});

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId: id });
		expect(msgs.find((m) => m._id === assistantMessageId)?.status).toBe('stopped');
	});
});
