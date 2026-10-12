/**
 * Knowledge extraction call avoidance (#1335; AI routing plan L7, M4, M6):
 *
 *   - `ai.knowledge` off: Team Inbox, file and Postbox extraction make no model,
 *     guard or embedding call at all, wherever they were scheduled from;
 *   - the live Postbox extraction rechecks the folder when it runs;
 *   - an entry `saveEntry` would answer with an existing row is not embedded
 *     (dedupe before embedding), and the write-time dedupe still holds;
 *   - the per-message entry cap is off by default and keeps the most confident
 *     entries when set;
 *   - relation inference makes no model call when no unlinked pair is left.
 *
 * Every model and embedding call is mocked; nothing reaches a provider.
 */
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { capExtractedEntries } from '../knowledge/extractionPolicy';
import { NO_EMBEDDING_SPACE_KEY } from '../lib/embeddingSpace';
import { createHash } from 'node:crypto';
import { hasLinkablePair, normalizeForHash } from '../lib/knowledgeEdges';

const mocks = vi.hoisted(() => ({ runLlmObject: vi.fn(), embed: vi.fn() }));

vi.mock('../lib/llm/dispatch', async () => ({
	...(await vi.importActual<object>('../lib/llm/dispatch')),
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => 'mock-model'),
}));
vi.mock('ai', async () => ({ ...(await vi.importActual<typeof Ai>('ai')), embed: mocks.embed }));

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

const BODY =
	'Our office moves to Hafenstrasse 12 on 1 March, and invoices now go to billing@example.com.';

type Entry = { type: 'fact'; title: string; content: string; confidence: number };
const fact = (title: string, confidence = 0.9): Entry => ({
	type: 'fact',
	title,
	content: `${title}.`,
	confidence,
});

let extracted: Entry[] = [];

beforeEach(() => {
	extracted = [fact('Office moves to Hafenstrasse 12'), fact('Invoices go to billing')];
	mocks.runLlmObject.mockReset();
	mocks.runLlmObject.mockImplementation(async () => ({ object: { entries: extracted } }));
	mocks.embed.mockReset();
	mocks.embed.mockImplementation(async () => ({
		embedding: [0.1, 0.2, 0.3],
		usage: { tokens: 1 },
	}));
});

/** A local embedder, so `resolveIndexEmbedder` resolves without any key. */
async function configureLocalAi(t: T) {
	await t.run((ctx) =>
		ctx.db.insert('aiProviderConfig', {
			languageProviderKind: 'openaiCompatible',
			languageBaseUrl: 'http://localhost:11434/v1',
			modelFast: 'qwen3.6:27b',
			modelCapable: 'qwen3.6:27b',
			embeddingProviderKind: 'local',
			embeddingModelVersion: 1,
			updatedAt: Date.now(),
		})
	);
}

async function seedPostboxMessage(
	t: T,
	role: 'inbox' | 'trash' = 'inbox'
): Promise<Id<'mailMessages'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: role,
			role,
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'move',
			participants: ['ana@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'move',
			latestFromAddress: 'ana@example.com',
			latestSubject: 'We are moving',
			folderRoles: [role],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		return ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<move@example.com>',
			threadId,
			fromAddress: 'ana@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'We are moving',
			normalizedSubject: 'move',
			snippet: 'move',
			textBodyInline: BODY,
			rawStorageId: await ctx.storage.store(new Blob(['raw'])),
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

const entriesOf = (t: T, sourceId: string) =>
	t.run((ctx) =>
		ctx.db
			.query('knowledgeEntries')
			.withIndex('by_source', (q) => q.eq('sourceType', 'email').eq('sourceId', sourceId))
			.collect()
	);

describe('#1335: ai.knowledge is enforced where extraction runs', () => {
	it('Team Inbox extraction makes no call with the flag off', async () => {
		const t = convexTest(schema, modules);
		await configureLocalAi(t);
		const inboundMessageId = await t.run((ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: 'm-1',
				from: 'customer@example.com',
				to: 'support@example.com',
				subject: 'Moving',
				textBody: BODY,
				receivedAt: Date.now(),
				processingStatus: 'draft_ready',
			})
		);
		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.embed).not.toHaveBeenCalled();
		const stored = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		expect(stored).toEqual([]);
	});

	it('file extraction makes no call with the flag off', async () => {
		const t = convexTest(schema, modules);
		await configureLocalAi(t);
		const fileId = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename: 'notes.txt',
				mimeType: 'text/plain',
				fileSize: 10,
				sourceType: 'upload',
				extractedText: `${BODY} ${BODY}`,
				version: 1,
				embedding: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
		await t.action(internal.knowledge.extraction.extractFromFile, { fileId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.embed).not.toHaveBeenCalled();
	});

	it('Postbox extraction makes no call with the flag off, and runs with it on', async () => {
		const t = convexTest(schema, modules);
		await configureLocalAi(t);
		const mailMessageId = await seedPostboxMessage(t);
		await t.action(internal.knowledge.extraction.extractFromMailMessage, { mailMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();

		await enableFeatures(t, ['ai.knowledge']);
		await t.action(internal.knowledge.extraction.extractFromMailMessage, { mailMessageId });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(await entriesOf(t, mailMessageId)).toHaveLength(2);
	});
});

describe('the live Postbox extraction rechecks the folder when it runs', () => {
	it('mail moved to Trash after delivery is not extracted', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		await configureLocalAi(t);
		const mailMessageId = await seedPostboxMessage(t, 'trash');
		await t.action(internal.mail.liveKnowledge.extractLiveMessage, { mailMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(
			await t.query(internal.mail.liveKnowledge.isInExtractableFolder, { mailMessageId })
		).toBe(false);
	});

	it('inbox mail passes the recheck', async () => {
		const t = convexTest(schema, modules);
		const mailMessageId = await seedPostboxMessage(t, 'inbox');
		expect(
			await t.query(internal.mail.liveKnowledge.isInExtractableFolder, { mailMessageId })
		).toBe(true);
	});
});

describe('M4: dedupe before embedding', () => {
	it('an entry that already exists is not embedded, and keeps its one row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		await configureLocalAi(t);
		const mailMessageId = await seedPostboxMessage(t);
		// Another message already stated the first fact (same normalized
		// content, same org-general scope): saveEntry would return that row.
		await t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: 'Office moves to Hafenstrasse 12',
				content: 'Office moves to Hafenstrasse 12.',
				sourceType: 'email',
				sourceId: 'another-message',
				contentHash: createHash('sha256')
					.update(
						normalizeForHash('Office moves to Hafenstrasse 12', 'Office moves to Hafenstrasse 12.')
					)
					.digest('hex'),
				embedding: [],
				confidence: 0.9,
				lastValidatedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		await t.action(internal.knowledge.extraction.extractFromMailMessage, { mailMessageId });

		// One embedding: the new fact only.
		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(mocks.embed.mock.calls[0]![0]).toMatchObject({
			value: 'Invoices go to billing: Invoices go to billing.',
		});
		const all = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		expect(all.map((e) => e.title).sort()).toEqual([
			'Invoices go to billing',
			'Office moves to Hafenstrasse 12',
		]);
	});

	it('a repeat within one batch is embedded once', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		await configureLocalAi(t);
		const mailMessageId = await seedPostboxMessage(t);
		extracted = [fact('Office moves to Hafenstrasse 12'), fact('Office moves to Hafenstrasse 12')];
		await t.action(internal.knowledge.extraction.extractFromMailMessage, { mailMessageId });
		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(await entriesOf(t, mailMessageId)).toHaveLength(1);
	});

	it('saveEntry still dedupes on write (the transactional leg)', async () => {
		const t = convexTest(schema, modules);
		const args = {
			entryType: 'fact' as const,
			title: 'Same title',
			content: 'Same.',
			sourceType: 'email' as const,
			sourceId: 'm-1',
			embedding: [],
			confidence: 0.9,
			embeddingSpaceKey: NO_EMBEDDING_SPACE_KEY,
		};
		const first = await t.mutation(internal.knowledge.graph.saveEntry, args);
		const second = await t.mutation(internal.knowledge.graph.saveEntry, args);
		expect(second).toBe(first);
	});
});

describe('L7: the per-message entry cap', () => {
	it('is off by default: every extracted entry is stored', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		await configureLocalAi(t);
		const mailMessageId = await seedPostboxMessage(t);
		extracted = [fact('A', 0.5), fact('B', 0.9), fact('C', 0.7)];
		await t.action(internal.knowledge.extraction.extractFromMailMessage, { mailMessageId });
		expect((await entriesOf(t, mailMessageId)).map((e) => e.title).sort()).toEqual(['A', 'B', 'C']);
	});

	it('keeps the most confident entries when the policy sets a cap', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		await configureLocalAi(t);
		await t.run((ctx) =>
			ctx.db.insert('aiRoutingPolicy', {
				knowledgeEntryCapPerMessage: 2,
				policyVersion: 1,
				updatedAt: Date.now(),
				updatedBy: 'admin',
			})
		);
		const mailMessageId = await seedPostboxMessage(t);
		extracted = [fact('A', 0.5), fact('B', 0.9), fact('C', 0.7)];
		await t.action(internal.knowledge.extraction.extractFromMailMessage, { mailMessageId });
		expect(mocks.embed).toHaveBeenCalledTimes(2);
		expect((await entriesOf(t, mailMessageId)).map((e) => e.title).sort()).toEqual(['B', 'C']);
	});

	it('capExtractedEntries keeps order and breaks ties by position', () => {
		const entries = [
			{ id: 1, confidence: 0.5 },
			{ id: 2, confidence: 0.9 },
			{ id: 3, confidence: 0.5 },
			{ id: 4, confidence: 0.7 },
		];
		expect(capExtractedEntries(entries, null)).toBe(entries);
		expect(capExtractedEntries(entries, 10)).toBe(entries);
		expect(capExtractedEntries(entries, 3).map((e) => e.id)).toEqual([1, 2, 4]);
		expect(capExtractedEntries(entries, 1).map((e) => e.id)).toEqual([2]);
	});
});

describe('M6: relation inference without an unlinked pair', () => {
	const a = { _id: 'a' } as const;
	const b = { _id: 'b' } as const;

	it('hasLinkablePair: an unlinked direction, a full set, a contact-scope wall', () => {
		expect(hasLinkablePair([a], new Set())).toBe(false);
		expect(hasLinkablePair([a, b], new Set())).toBe(true);
		expect(hasLinkablePair([a, b], new Set(['a:b']))).toBe(true);
		expect(hasLinkablePair([a, b], new Set(['a:b', 'b:a']))).toBe(false);
		const c1 = { _id: 'x', contactIds: ['c1' as Id<'contacts'>] };
		const c2 = { _id: 'y', contactIds: ['c2' as Id<'contacts'>] };
		expect(hasLinkablePair([c1, c2], new Set())).toBe(false);
	});

	async function seedLinkedPair(t: T, linkBothWays: boolean) {
		const save = (title: string) =>
			t.mutation(internal.knowledge.graph.saveEntry, {
				entryType: 'fact',
				title,
				content: `${title}.`,
				sourceType: 'manual',
				embedding: [],
				confidence: 0.9,
				embeddingSpaceKey: NO_EMBEDDING_SPACE_KEY,
			});
		const first = await save('Office hours are nine to five');
		const second = await save('The office closes on public holidays');
		await t.run(async (ctx) => {
			const edge = (from: typeof first, to: typeof first) =>
				ctx.db.insert('knowledgeRelations', {
					fromEntryId: from,
					toEntryId: to,
					relationType: 'relates_to',
					confidenceTag: 'extracted',
					confidence: 1,
					provenance: 'manual',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			await edge(first, second);
			if (linkBothWays) await edge(second, first);
		});
		return [first, second];
	}

	it('makes no model call when every pair is linked both ways', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge', 'ai.knowledge.autoLink']);
		const entryIds = await seedLinkedPair(t, true);
		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('still asks when one direction is unlinked', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge', 'ai.knowledge.autoLink']);
		mocks.runLlmObject.mockImplementation(async () => ({ object: { relations: [] } }));
		const entryIds = await seedLinkedPair(t, false);
		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
	});
});
