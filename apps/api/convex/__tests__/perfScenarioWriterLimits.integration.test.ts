/**
 * The component performance scenarios (apps/web/perf, plan item OW-073) size
 * their workloads from WRITER_LIMITS (scripts/perf-scenarios/writerLimits.ts).
 * This holds each value to the backend's effective behaviour, so a real change
 * of a limit fails here, and a refactor that keeps the behaviour does not:
 *
 * - the output ceiling a real assistant turn is dispatched with, resolved by
 *   `callShape` (the resolver every dispatch uses) from the meter the runner
 *   hands the stream;
 * - the runner's write cadence, observed on the assistant row while a mocked
 *   stream delivers text on a controlled clock;
 * - the longest question and chat message the mutations accept;
 * - the history `assistant.conversations.listMessages` and one
 *   `chat.messages.listMessages` page return.
 */
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITER_LIMITS } from '../../../../scripts/perf-scenarios/writerLimits';
import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import type * as LlmProviderModule from '../lib/llmProvider';
import type * as DispatchModule from '../lib/llm/dispatch';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { metered } from '../analytics/__tests__/meteredDispatch.testlib';
import { callShape } from '../lib/llm/callShape';
import { runLlmStream } from '../lib/llm/dispatch';
import schema from '../schema';
import { enableFeatures } from './factories';

const modules = import.meta.glob('../**/*.*s');
const USER = 'user-perf';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../lib/sessionOrganization'
	);
	const session = { userId: 'user-perf', role: 'owner' as const, activeOrganizationId: 'test-org' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		requireOrgPermission: vi.fn(async () => session),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => session.userId),
		getMutationContext: vi.fn(async () => session),
	};
});

// No model and no provider: the stream is driven by the test.
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	return {
		...actual,
		resolveLanguageModel: vi.fn(() => 'test-model'),
		resolveLanguageModelForUserText: vi.fn(() => 'test-model'),
	};
});
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof DispatchModule>('../lib/llm/dispatch');
	return { ...actual, runLlmStream: vi.fn() };
});

function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}
type T = ReturnType<typeof makeT>;

async function newConversation(t: T) {
	await enableFeatures(t, ['ai.assistant']);
	return t.mutation(api.assistant.conversations.createConversation, {});
}

async function startTurn(t: T) {
	const conversationId = await newConversation(t);
	const { assistantMessageId } = await t.mutation(api.assistant.conversations.sendMessage, {
		conversationId,
		text: 'How did the welcome campaign do?',
	});
	return { conversationId, assistantMessageId };
}

const FINISHED = {
	tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	modelUsed: 'test-model',
	finishReason: 'stop',
	aborted: false,
} as const;

beforeEach(() => {
	vi.mocked(runLlmStream).mockReset();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('assistant answer stream', () => {
	it('is dispatched under the output ceiling the fixture assumes', async () => {
		const t = makeT();
		const { conversationId, assistantMessageId } = await startTurn(t);
		let ceiling: number | undefined;
		vi.mocked(runLlmStream).mockImplementation(
			metered(async (opts) => {
				// A model with its own reasoning budget is sent the output allowance
				// alone: the most visible text an answer can hold.
				ceiling = callShape({
					model: { modelId: 'perf-contract-model', provider: 'anthropic.messages' },
					meter: opts.meter,
					maxOutputTokens: opts.maxOutputTokens,
				}).maxOutputTokens;
				return { ...FINISHED, text: 'ok' };
			})
		);

		await t.action(internal.assistant.runner.run, {
			conversationId,
			assistantMessageId,
			ownerId: USER,
		});

		expect(ceiling).toBe(WRITER_LIMITS.assistantMaxOutputTokens);
	});

	it('writes the whole answer so far at most once per flush interval', async () => {
		const t = makeT();
		const { conversationId, assistantMessageId } = await startTurn(t);
		const interval = WRITER_LIMITS.assistantFlushIntervalMs;
		// Text arrives every fifth of an interval for six intervals.
		const step = interval / 5;
		const deltas = 30;
		const start = Date.UTC(2026, 9, 19, 9, 0, 0);
		const writes: { at: number; text: string }[] = [];

		vi.mocked(runLlmStream).mockImplementation(
			metered(async (opts) => {
				let full = '';
				let stored = '';
				for (let i = 0; i < deltas; i++) {
					vi.setSystemTime(start + i * step);
					full += `word${i} `;
					await opts.onTextDelta?.(full, `word${i} `);
					const rows = await t.query(api.assistant.conversations.listMessages, {
						conversationId,
					});
					const text = rows.find((m) => m._id === assistantMessageId)?.text ?? '';
					if (text !== stored) {
						writes.push({ at: start + i * step, text });
						stored = text;
					}
				}
				return { ...FINISHED, text: full };
			})
		);

		// Only Date is faked: the runner's Stop poll keeps its real timer.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(start);
		await t.action(internal.assistant.runner.run, {
			conversationId,
			assistantMessageId,
			ownerId: USER,
		});

		// One write per interval, the first at once, each carrying the whole text so far.
		expect(writes.map((w) => w.at - start)).toEqual(
			Array.from({ length: (deltas * step) / interval }, (_, i) => i * interval)
		);
		for (const [i, w] of writes.entries()) {
			const delivered = Array.from(
				{ length: (i * interval) / step + 1 },
				(_, j) => `word${j} `
			).join('');
			expect(w.text).toBe(delivered);
		}
	});
});

describe('assistant conversation limits', () => {
	it('accepts a question at the length limit and refuses one past it', async () => {
		const t = makeT();
		const conversationId = await newConversation(t);
		const max = WRITER_LIMITS.assistantQuestionMaxChars;
		await expect(
			t.mutation(api.assistant.conversations.sendMessage, {
				conversationId,
				text: 'q'.repeat(max + 1),
			})
		).rejects.toThrow(/exceeds/);
		await expect(
			t.mutation(api.assistant.conversations.sendMessage, {
				conversationId,
				text: 'q'.repeat(max),
			})
		).resolves.toMatchObject({ assistantMessageId: expect.any(String) });
	});

	it('hands a reader the newest history-limit messages', async () => {
		const t = makeT();
		const conversationId = await newConversation(t);
		const limit = WRITER_LIMITS.assistantHistoryLimit;
		await t.run(async (ctx) => {
			for (let i = 0; i < limit + 5; i++) {
				await ctx.db.insert('aiMessages', {
					conversationId,
					ownerId: USER,
					role: i % 2 ? 'assistant' : 'user',
					text: `message ${i}`,
					status: 'complete',
					createdAt: 1_000 + i,
				});
			}
		});
		const rows = await t.query(api.assistant.conversations.listMessages, { conversationId });
		expect(rows).toHaveLength(limit);
		expect(rows[rows.length - 1]?.text).toBe(`message ${limit + 4}`);
	});
});

describe('chat room limits', () => {
	async function newRoom(t: T): Promise<Id<'chatRooms'>> {
		await enableFeatures(t, ['chat']);
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'perf',
			visibility: 'public',
		});
		if (!roomId) throw new Error('createChannel returned no room');
		return roomId;
	}

	it('accepts a message at the length limit and refuses one past it', async () => {
		const t = makeT();
		const roomId = await newRoom(t);
		const max = WRITER_LIMITS.chatMessageMaxChars;
		await expect(
			t.mutation(api.chat.messages.sendMessage, { roomId, text: 'm'.repeat(max + 1) })
		).rejects.toThrow(/maximum length/);
		await t.mutation(api.chat.messages.sendMessage, { roomId, text: 'm'.repeat(max) });
		const { messages } = await t.query(api.chat.messages.listMessages, { roomId });
		expect(messages[messages.length - 1]?.text).toHaveLength(max);
	});

	it('returns at most the page cap, however large the limit asked', async () => {
		const t = makeT();
		const roomId = await newRoom(t);
		const cap = WRITER_LIMITS.chatHistoryLimit;
		await t.run(async (ctx) => {
			for (let i = 0; i < cap + 5; i++) {
				await ctx.db.insert('chatMessages', {
					roomId,
					authorId: USER,
					text: `message ${i}`,
					createdAt: 1_000 + i,
				});
			}
		});
		const page = await t.query(api.chat.messages.listMessages, { roomId, limit: cap * 2 });
		expect(page.messages).toHaveLength(cap);
		expect(page.hasMore).toBe(true);
	});
});
