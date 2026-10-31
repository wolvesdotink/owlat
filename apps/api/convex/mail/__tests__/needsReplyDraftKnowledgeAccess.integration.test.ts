/**
 * The Reply Queue's starter draft never carries knowledge kept to shared-inbox
 * readers. The draft lands on the card, and every
 * member of the mailbox reads it through `getPreparedDraft`, so the recall
 * tool the draft runs with must search what members may see. Here the real
 * `draftWithAnswers` action runs with the real recall tool and the real
 * knowledge retrieval; only the model is replaced, by one that calls the tool
 * and writes what it got back into the draft.
 */
import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import type * as DraftService from '../../agent/shared/draftService';
import type * as AskEagerness from '../../inbox/askEagerness';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { enableFeatures } from '../../__tests__/factories';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const mocks = vi.hoisted(() => ({ embed: vi.fn() }));

type RecallTool = {
	execute: (
		input: { query: string },
		options: unknown
	) => Promise<{
		facts: Array<{ content: string }>;
	}>;
};

// The model: recall twice, then write every fact it got into the draft.
vi.mock('../../agent/shared/draftService', async () => {
	const actual = await vi.importActual<typeof DraftService>('../../agent/shared/draftService');
	return {
		...actual,
		runSharedDraft: vi.fn(
			async (_ctx: unknown, params: { tools: { recallKnowledge: RecallTool } }) => {
				const facts: string[] = [];
				for (const query of ['acquisition price', 'office hours']) {
					const result = await params.tools.recallKnowledge.execute(
						{ query },
						{ toolCallId: query, messages: [] }
					);
					facts.push(...result.facts.map((f) => f.content));
				}
				return {
					draftBody: `Hi Jonas. ${facts.join(' ')}`,
					draftQuality: { score: 0.9, complete: true, grounded: true, flags: [] },
					tokenUsage: undefined,
					modelUsed: 'mock-model',
				};
			}
		),
	};
});
vi.mock('../../inbox/askEagerness', async () => ({
	...(await vi.importActual<typeof AskEagerness>('../../inbox/askEagerness')),
	shouldSampleDraftDelta: () => false,
}));
vi.mock('../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => 'mock-model'),
}));
vi.mock('ai', async () => ({ ...(await vi.importActual<typeof Ai>('ai')), embed: mocks.embed }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	// The mailbox's own user, an editor: not a shared-inbox reader.
	const session = async () => ({
		userId: 'user-A',
		role: 'editor' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

type T = TestConvex<typeof schema>;

beforeEach(() => {
	mocks.embed.mockReset();
	mocks.embed.mockImplementation(async () => ({
		embedding: [0.1, 0.2, 0.3],
		usage: { tokens: 1 },
	}));
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('not found', { status: 404 }))
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const SECRET = 'The acquisition price is four million euros.';
const OPEN = 'The office hours are nine to five.';

async function seed(t: T): Promise<Id<'mailThreads'>> {
	await enableFeatures(t, ['ai', 'ai.knowledge']);
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	await seedFolder(t, mailboxId);
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'Question',
		fromAddress: 'jonas@brightpath.example',
	});
	return t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('aiProviderConfig', {
			languageProviderKind: 'openaiCompatible',
			languageBaseUrl: 'http://localhost:11434/v1',
			modelFast: 'qwen3.6:27b',
			modelCapable: 'qwen3.6:27b',
			embeddingProviderKind: 'local',
			embeddingModelVersion: 1,
			updatedAt: now,
		});
		const entry = (content: string, source: { sourceType: 'file' | 'manual'; sourceId?: string }) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: content,
				content,
				...source,
				embedding: [],
				searchableText: content,
				confidence: 0.9,
				lastValidatedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		// Learned from a captured attachment (its file is gone, so it stays restricted).
		await entry(SECRET, { sourceType: 'file', sourceId: 'gone-file' });
		await entry(OPEN, { sourceType: 'manual' });
		const message = (await ctx.db.get(messageId))!;
		await ctx.db.patch(message.threadId!, {
			needsReply: {
				messageId,
				detectedAt: now,
				source: 'llm',
				urgency: 'normal',
				clarification: {
					isNeeded: true,
					askedAt: now,
					answeredAt: now,
					questions: [
						{
							id: 'clarify_0',
							slotType: 'factual_lookup',
							text: 'When can they call?',
							answer: { value: 'Any weekday', at: now, source: 'user' },
						},
					],
				},
			},
		});
		return message.threadId!;
	});
}

describe('Reply Queue draft — knowledge recall visibility', () => {
	it('drafts with member-visible knowledge only, so the mailbox editor never reads a restricted fact', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const threadId = await seed(t);

		await t.action(internal.mail.ai.needsReplyClassify.draftWithAnswers, { threadId });

		const prepared = await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId });
		const draft = prepared?.clarificationDraft ?? '';
		// The recall ran and landed what members may see…
		expect(draft).toContain(OPEN);
		// …and nothing kept to shared-inbox readers.
		expect(draft).not.toContain('four million');
	});
});
