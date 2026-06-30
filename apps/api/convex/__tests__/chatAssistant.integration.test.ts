import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { runLlmStream } from '../lib/llm/dispatch';
import { ASSISTANT_AUTHOR_ID } from '../chat/_helpers';

/**
 * Team-chat @assistant: an explicit @assistant mention (when ai.assistant is on)
 * posts a streaming assistant reply visible to the whole room, driven by the
 * shared runner. Covers the sendMessage trigger, the feature gate, the
 * isAssistant render flag, the runner's chat path (mocked LLM), and the internal
 * patch/finalize mutations.
 */

const modules = import.meta.glob('../**/*.*s');
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

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, getLLMProvider: vi.fn(() => 'test-model'), getLLMProviderForUserText: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmStream: vi.fn() };
});

function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

/** Insert a public channel the user belongs to; return the room id. */
async function seedRoom(t: ReturnType<typeof makeT>): Promise<Id<'chatRooms'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'channel',
			name: 'general',
			normalizedName: 'general',
			visibility: 'public',
			createdBy: 'user-a',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 0,
		});
		await ctx.db.insert('chatRoomMembers', {
			roomId,
			memberId: 'user-a',
			role: 'admin',
			joinedAt: now,
			lastReadAt: 0,
		});
		return roomId;
	});
}

beforeEach(() => {
	sess.user = { userId: 'user-a', role: 'owner' };
	vi.mocked(runLlmStream).mockReset();
});

describe('chat @assistant — trigger', () => {
	it('posts a streaming assistant placeholder when @assistant is invoked and the feature is on', async () => {
		const t = makeT();
		await enableFeatures(t, ['chat', 'ai.assistant']);
		const roomId = await seedRoom(t);

		await t.mutation(api.chat.messages.sendMessage, {
			roomId,
			text: '@assistant what is our open rate?',
		});

		const { messages } = await t.query(api.chat.messages.listMessages, { roomId });
		expect(messages).toHaveLength(2);
		const human = messages.find((m) => !m.isAssistant);
		const assistant = messages.find((m) => m.isAssistant);
		expect(human?.text).toContain('open rate');
		expect(assistant).toBeTruthy();
		expect(assistant?.authorId).toBe(ASSISTANT_AUTHOR_ID);
		expect(assistant?.aiStatus).toBe('streaming');
		expect(assistant?.author?.name).toBe('Assistant');
	});

	it('does NOT invoke the assistant when ai.assistant is off (message still posts)', async () => {
		const t = makeT();
		await enableFeatures(t, ['chat']); // no ai.assistant
		const roomId = await seedRoom(t);

		await t.mutation(api.chat.messages.sendMessage, { roomId, text: '@assistant hello?' });

		const { messages } = await t.query(api.chat.messages.listMessages, { roomId });
		expect(messages).toHaveLength(1);
		expect(messages[0]?.isAssistant).toBe(false);
	});

	it('does not invoke the assistant for an ordinary message', async () => {
		const t = makeT();
		await enableFeatures(t, ['chat', 'ai.assistant']);
		const roomId = await seedRoom(t);
		await t.mutation(api.chat.messages.sendMessage, { roomId, text: 'just a normal message' });
		const { messages } = await t.query(api.chat.messages.listMessages, { roomId });
		expect(messages).toHaveLength(1);
		expect(messages.some((m) => m.isAssistant)).toBe(false);
	});
});

describe('chat @assistant — runner reply (mocked LLM)', () => {
	it('streams a reply into the room message to completion', async () => {
		const t = makeT();
		await enableFeatures(t, ['chat', 'ai.assistant']);
		const roomId = await seedRoom(t);
		await t.mutation(api.chat.messages.sendMessage, { roomId, text: '@assistant summarize' });

		const before = await t.query(api.chat.messages.listMessages, { roomId });
		const assistantId = before.messages.find((m) => m.isAssistant)!._id as Id<'chatMessages'>;
		const promptId = before.messages.find((m) => !m.isAssistant)!._id as Id<'chatMessages'>;

		vi.mocked(runLlmStream).mockImplementation(async (opts) => {
			await opts.onTextDelta?.('Here is', 'Here is');
			await opts.onTextDelta?.('Here is the summary.', ' the summary.');
			return {
				text: 'Here is the summary.',
				tokenUsage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
				modelUsed: 'test-model',
				finishReason: 'stop',
				aborted: false,
			};
		});

		await t.action(internal.assistant.runner.runForChat, {
			roomId,
			assistantMessageId: assistantId,
			promptMessageId: promptId,
		});

		const after = await t.query(api.chat.messages.listMessages, { roomId });
		const assistant = after.messages.find((m) => m._id === assistantId);
		expect(assistant?.aiStatus).toBe('complete');
		expect(assistant?.text).toBe('Here is the summary.');
		expect(assistant?.model).toBe('test-model');

		const spend = await t.run(async (ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(spend.some((e) => e.feature === 'chat_assistant')).toBe(true);
	});

	it('leaves a visible fallback when the stream errors', async () => {
		const t = makeT();
		await enableFeatures(t, ['chat', 'ai.assistant']);
		const roomId = await seedRoom(t);
		await t.mutation(api.chat.messages.sendMessage, { roomId, text: '@assistant help' });
		const before = await t.query(api.chat.messages.listMessages, { roomId });
		const assistantId = before.messages.find((m) => m.isAssistant)!._id as Id<'chatMessages'>;
		const promptId = before.messages.find((m) => !m.isAssistant)!._id as Id<'chatMessages'>;

		vi.mocked(runLlmStream).mockImplementation(async () => {
			throw new Error('boom');
		});

		await t.action(internal.assistant.runner.runForChat, {
			roomId,
			assistantMessageId: assistantId,
			promptMessageId: promptId,
		});

		const after = await t.query(api.chat.messages.listMessages, { roomId });
		const assistant = after.messages.find((m) => m._id === assistantId);
		expect(assistant?.aiStatus).toBe('error');
		expect(assistant?.text).toContain('could not complete');
	});
});

describe('chat @assistant — internal mutations', () => {
	it('patch signals stop once the assistant message is deleted', async () => {
		const t = makeT();
		await enableFeatures(t, ['chat', 'ai.assistant']);
		const roomId = await seedRoom(t);
		await t.mutation(api.chat.messages.sendMessage, { roomId, text: '@assistant hi' });
		const before = await t.query(api.chat.messages.listMessages, { roomId });
		const assistantId = before.messages.find((m) => m.isAssistant)!._id as Id<'chatMessages'>;

		const r1 = await t.mutation(internal.chat.messages.patchAssistantChatMessage, {
			messageId: assistantId,
			text: 'partial',
		});
		expect(r1.stop).toBe(false);

		await t.mutation(api.chat.messages.deleteMessage, { messageId: assistantId });
		const r2 = await t.mutation(internal.chat.messages.patchAssistantChatMessage, {
			messageId: assistantId,
			text: 'more',
		});
		expect(r2.stop).toBe(true);
	});
});
