/**
 * Knowledge learned from a captured mail attachment keeps the attachment's
 * restriction (#1322): extracted through the real `extractFromFile`, it is
 * not returned to an unrelated editor by the public knowledge reads nor by the
 * assistant's knowledge retrieval, while knowledge from an uploaded file stays
 * member-visible. The write resolves who may see an entry from the SOURCE
 * FILE (knowledge/entryDedupe.ts `resolveMemberAccess`), so a writer from a
 * previous release that passes nothing still stores a restricted entry.
 *
 * Every model and embedding call is mocked; nothing reaches a provider.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { MIGRATION } from '../migrations/0069_restrict_captured_file_knowledge';

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

const sessionMock = vi.hoisted(() => ({ role: 'editor' as 'owner' | 'editor' }));
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.role === 'owner' ? 'boss' : 'bystander',
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

const modules = import.meta.glob('../**/*.*s');
type T = TestConvex<typeof schema>;

beforeEach(() => {
	sessionMock.role = 'editor';
	mocks.runLlmObject.mockReset();
	mocks.runLlmObject.mockImplementation(async (opts: { prompt?: string }) => {
		const isCapture = String(opts.prompt ?? '').includes('Confidential');
		const title = isCapture ? 'Acquisition price agreed' : 'Office opening hours';
		return {
			object: { entries: [{ type: 'fact', title, content: `${title}.`, confidence: 0.9 }] },
		};
	});
	mocks.embed.mockReset();
	mocks.embed.mockImplementation(async () => ({
		embedding: [0.1, 0.2, 0.3],
		usage: { tokens: 1 },
	}));
	// The clock is fake too, so a test moves it past the rows it wrote.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('not found', { status: 404 }))
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function seed(t: T) {
	await enableFeatures(t, ['ai.knowledge', 'postbox']);
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
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'victim',
			organizationId: 'test-org',
			address: 'victim@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const file = (
			filename: string,
			text: string,
			fields: Partial<Pick<Doc<'semanticFiles'>, 'captureSource' | 'sourceMailboxId'>>
		) =>
			ctx.db.insert('semanticFiles', {
				filename,
				mimeType: 'text/plain',
				fileSize: text.length,
				sourceType: fields.captureSource ? 'email_attachment' : 'upload',
				...fields,
				extractedText: text,
				version: 1,
				embedding: [],
				createdAt: now,
				updatedAt: now,
			});
		return {
			capture: await file(
				'term-sheet.txt',
				'Confidential: the acquisition price was agreed at four million euros.',
				{ captureSource: 'mailbox', sourceMailboxId: mailboxId }
			),
			upload: await file(
				'hours.txt',
				'The office is open Monday to Friday from nine to five, closed on holidays.',
				{}
			),
		};
	});
}

const titles = (rows: Array<{ title: string }> | null) => (rows ?? []).map((r) => r.title).sort();

async function recall(t: T, includeInboxDerived: boolean, queryText: string) {
	const hits = await t.action(internal.knowledge.retrieval.semanticSearch, {
		queryText,
		scopeToContact: 'org-wide',
		includeInboxDerived,
	});
	return titles(hits);
}

describe('knowledge extracted from a captured file', () => {
	it('is kept from an unrelated editor by the knowledge reads and the assistant retrieval', async () => {
		const t = convexTest(schema, modules);
		const files = await seed(t);
		await t.action(internal.knowledge.extraction.extractFromFile, { fileId: files.capture });
		await t.action(internal.knowledge.extraction.extractFromFile, { fileId: files.upload });

		const stored = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		const byTitle = new Map(stored.map((e) => [e.title, e]));
		expect(byTitle.get('Acquisition price agreed')?.memberAccess).toBe('restricted');
		expect(byTitle.get('Office opening hours')?.memberAccess).toBe('members');

		sessionMock.role = 'editor';
		expect(titles(await t.query(api.knowledge.graph.listAll, {}))).toEqual([
			'Office opening hours',
		]);
		const captured = byTitle.get('Acquisition price agreed')!;
		expect(await t.query(api.knowledge.graph.getEntry, { entryId: captured._id })).toBeNull();
		// What the assistant and quick query search for a non-reader.
		expect(await recall(t, false, 'acquisition price')).not.toContain('Acquisition price agreed');
		expect(await recall(t, true, 'acquisition price')).toContain('Acquisition price agreed');

		sessionMock.role = 'owner';
		expect(titles(await t.query(api.knowledge.graph.listAll, {}))).toEqual([
			'Acquisition price agreed',
			'Office opening hours',
		]);
	});

	it('a Team Inbox entry restricted by migration 0069 still reaches the Team Inbox agent', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const id = await t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: 'Refund window',
				content: 'The refund window is thirty days.',
				sourceType: 'agent_extracted',
				embedding: [],
				searchableText: 'Refund window The refund window is thirty days.',
				confidence: 0.9,
				lastValidatedAt: 1,
				createdAt: 1,
				updatedAt: 1,
			})
		);
		// The walk starts after the entry was written.
		vi.setSystemTime(Date.now() + 1_000);
		await t.mutation(internal.migrations[MIGRATION].run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await t.run((ctx) => ctx.db.get(id)))?.memberAccess).toBe('restricted');
		// The agent's retrieval includes what is kept from members; a member's does not.
		expect(await recall(t, true, 'refund window')).toContain('Refund window');
		expect(await recall(t, false, 'refund window')).not.toContain('Refund window');
	});

	it('stays restricted when a previous release writes it after migration 0069 has run', async () => {
		const t = convexTest(schema, modules);
		const files = await seed(t);
		await t.mutation(internal.migrations[MIGRATION].run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		// The previous release's extraction knows nothing of `memberAccess`.
		const oldShaped = {
			entryType: 'fact' as const,
			title: 'Acquisition price agreed',
			content: 'Acquisition price agreed.',
			sourceType: 'file' as const,
			sourceId: files.capture as string,
			embedding: [],
			confidence: 0.9,
		};
		const entryId = await t.mutation(internal.knowledge.graph.saveEntry, oldShaped);
		const entry = await t.run((ctx) => ctx.db.get(entryId));
		expect(entry?.memberAccess).toBe('restricted');
		expect(titles(await t.query(api.knowledge.graph.listAll, {}))).toEqual([]);
	});

	it('restricts a member-visible duplicate of the same source instead of returning it', async () => {
		const t = convexTest(schema, modules);
		const files = await seed(t);
		const stale = await t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: 'Acquisition price agreed',
				content: 'Acquisition price agreed.',
				sourceType: 'file',
				sourceId: files.capture,
				memberAccess: 'members',
				embedding: [],
				confidence: 0.9,
				lastValidatedAt: 1,
				createdAt: 1,
				updatedAt: 1,
			})
		);
		const id: Id<'knowledgeEntries'> = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'Acquisition price agreed',
			content: 'Acquisition price agreed.',
			sourceType: 'file',
			sourceId: files.capture,
			embedding: [],
			confidence: 0.9,
		});
		expect(id).toBe(stale);
		expect((await t.run((ctx) => ctx.db.get(stale)))?.memberAccess).toBe('restricted');
	});
});
