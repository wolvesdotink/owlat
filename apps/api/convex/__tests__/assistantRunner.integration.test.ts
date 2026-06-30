import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { enableFeatures } from './factories';
import { runLlmStream } from '../lib/llm/dispatch';

/**
 * Conversation runner orchestration with a MOCKED LLM stream: it must drive the
 * streaming assistant row from `streaming` → terminal, persist tool-call cards
 * and token usage, record spend, and surface errors — without ever calling a
 * real model.
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

// Stub the model resolver so the runner doesn't require a real LLM API key, and
// the streaming seam so we drive the callbacks deterministically.
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return {
		...actual,
		getLLMProvider: vi.fn(() => 'test-model'),
		getLLMProviderForUserText: vi.fn(() => 'test-model'),
	};
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

/** Create a conversation + an empty streaming assistant turn, return the ids. */
async function startTurn(t: ReturnType<typeof makeT>) {
	await enableFeatures(t, ['ai.assistant']);
	const conversationId = await t.mutation(api.assistant.conversations.createConversation, {});
	const { assistantMessageId } = await t.mutation(api.assistant.conversations.sendMessage, {
		conversationId,
		text: 'What is the open rate of the welcome campaign?',
	});
	return { conversationId, assistantMessageId };
}

beforeEach(() => {
	sess.user = { userId: 'user-a', role: 'owner' };
	vi.mocked(runLlmStream).mockReset();
});

describe('assistant runner', () => {
	it('streams text + tool cards to completion, persisting usage', async () => {
		const t = makeT();
		const { conversationId, assistantMessageId } = await startTurn(t);

		vi.mocked(runLlmStream).mockImplementation(async (opts) => {
			await opts.onToolCall?.({ toolCallId: 'tc1', toolName: 'searchKnowledge', input: { query: 'welcome campaign' } });
			await opts.onToolResult?.({ toolCallId: 'tc1', toolName: 'searchKnowledge', output: { results: [{ title: 'Welcome' }] } });
			await opts.onTextDelta?.('The open', 'The open');
			await opts.onTextDelta?.('The open rate was 42%.', ' rate was 42%.');
			return {
				text: 'The open rate was 42%.',
				tokenUsage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
				modelUsed: 'test-model',
				finishReason: 'stop',
				aborted: false,
			};
		});

		await t.action(internal.assistant.runner.run, {
			conversationId,
			assistantMessageId,
			ownerId: 'user-a',
		});

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId });
		const assistant = msgs.find((m) => m._id === assistantMessageId);
		expect(assistant?.status).toBe('complete');
		expect(assistant?.text).toBe('The open rate was 42%.');
		expect(assistant?.model).toBe('test-model');
		expect(assistant?.tokenUsage?.totalTokens).toBe(20);
		expect(assistant?.toolCalls).toHaveLength(1);
		expect(assistant?.toolCalls?.[0]).toMatchObject({ toolName: 'searchKnowledge', status: 'done' });

		// Spend recorded under the conversation feature tag.
		const spend = await t.run(async (ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(spend.some((e) => e.feature === 'assistant_chat' && e.totalTokens === 20)).toBe(true);
	});

	it('marks the turn errored when the stream throws, keeping partial text', async () => {
		const t = makeT();
		const { conversationId, assistantMessageId } = await startTurn(t);

		vi.mocked(runLlmStream).mockImplementation(async (opts) => {
			await opts.onTextDelta?.('Half a thought', 'Half a thought');
			throw new Error('model overloaded');
		});

		await t.action(internal.assistant.runner.run, { conversationId, assistantMessageId, ownerId: 'user-a' });

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId });
		const assistant = msgs.find((m) => m._id === assistantMessageId);
		expect(assistant?.status).toBe('error');
		expect(assistant?.errorMessage).toContain('overloaded');
		expect(assistant?.text).toBe('Half a thought');
	});

	it('marks the turn stopped when the stream reports it was aborted', async () => {
		const t = makeT();
		const { conversationId, assistantMessageId } = await startTurn(t);

		vi.mocked(runLlmStream).mockImplementation(async (opts) => {
			await opts.onTextDelta?.('Starting…', 'Starting…');
			return { text: 'Starting…', tokenUsage: undefined, modelUsed: 'test-model', finishReason: undefined, aborted: true };
		});

		await t.action(internal.assistant.runner.run, { conversationId, assistantMessageId, ownerId: 'user-a' });

		const msgs = await t.query(api.assistant.conversations.listMessages, { conversationId });
		expect(msgs.find((m) => m._id === assistantMessageId)?.status).toBe('stopped');
	});
});
