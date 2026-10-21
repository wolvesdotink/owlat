/**
 * A contact's files as compact cards (`files.cards.listByContact`, #1439).
 *
 * The contact Files tab and the Team Answer attach menu show a name, a size, a
 * date, the source and a couple of tags. `semanticFiles.listByContact` handed
 * them every linked row whole (embedding vectors, extracted and search text)
 * and resolved a storage URL for every readable file before it sorted and
 * dropped the ones past `limit`. Both endpoints now select through
 * `readableContactFiles`: newest first, read-gated, capped, and only then
 * projected. The legacy endpoint keeps its whole-row shape for older clients.
 */

import { convexTest } from 'convex-test';
import { convexToJson, type Value } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import {
	listContactFileCards,
	readableContactFiles,
	type StorageReader,
} from '../lib/semanticFileCards';

const sessionMock = vi.hoisted(() => ({
	userId: 'boss',
	role: 'owner' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getSingletonOrganizationId: vi.fn(async () => 'test-org'),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;

beforeEach(() => {
	sessionMock.userId = 'boss';
	sessionMock.role = 'owner';
});

const CARD_KEYS = [
	'_id',
	'autoTags',
	'createdAt',
	'fileSize',
	'filename',
	'hasBytes',
	'mimeType',
	'sourceType',
	'summary',
	'tags',
	'title',
	'updatedAt',
	'url',
	'version',
];

/** Deterministic stand-in for a 1,536-dimension embedding. */
function vector(seed: number): number[] {
	return Array.from({ length: 1536 }, (_, i) => ((seed * 31 + i * 7) % 97) / 97 - 0.5);
}

async function newContact(t: Harness): Promise<Id<'contacts'>> {
	return t.run((ctx) =>
		ctx.db.insert('contacts', {
			email: 'ana@example.com',
			source: 'api',
			doiStatus: 'not_required',
			createdAt: 1,
			updatedAt: 1,
		})
	);
}

async function newThread(t: Harness): Promise<Id<'conversationThreads'>> {
	return t.run((ctx) =>
		ctx.db.insert('conversationThreads', {
			subject: 'Order 4417',
			normalizedSubject: 'order 4417',
			contactIdentifier: 'ana@example.com',
			status: 'open',
			messageCount: 1,
			firstMessageAt: 1,
			lastMessageAt: 1,
			createdAt: 1,
		})
	);
}

/** A processed file linked to `contactId`, as the pipeline leaves it. */
async function linkedFile(
	t: Harness,
	contactId: Id<'contacts'>,
	createdAt: number,
	overrides: Partial<Doc<'semanticFiles'>> & { released?: boolean } = {}
): Promise<Id<'semanticFiles'>> {
	const { released, ...fields } = overrides;
	return t.run(async (ctx) => {
		const storageId = released
			? undefined
			: await ctx.storage.store(new Blob([`file ${createdAt}`]));
		const fileId = await ctx.db.insert('semanticFiles', {
			storageId,
			filename: `file-${createdAt}.pdf`,
			title: `File ${createdAt}`,
			summary: 'Quarterly numbers.',
			mimeType: 'application/pdf',
			fileSize: 1000 + createdAt,
			tags: ['finance'],
			autoTags: ['quarterly'],
			extractedText: 'invoice delivery contract '.repeat(400),
			searchableText: `file ${createdAt} invoice delivery contract`,
			sourceType: 'upload',
			uploadedBy: 'boss',
			contactIds: [contactId],
			version: 1,
			embedding: vector(createdAt),
			secondaryEmbedding: vector(createdAt + 1),
			embeddingModel: 'text-embedding-3-small',
			createdAt,
			updatedAt: createdAt,
			...fields,
		});
		await ctx.db.insert('semanticFileContacts', { fileId, contactId });
		return fileId;
	});
}

/** createdAt 1..n in a fixed shuffled insertion order. */
function shuffled(n: number): number[] {
	const out = Array.from({ length: n }, (_, i) => i + 1);
	for (let i = n - 1; i > 0; i--) {
		const j = (i * 7 + 3) % (i + 1);
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

describe('files.cards.listByContact — the card', () => {
	it('returns named card fields only, never vectors, extracted or search text', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		await linkedFile(t, contactId, 5);

		const cards = await t.query(api.files.cards.listByContact, { contactId });
		expect(cards).toHaveLength(1);
		expect(Object.keys(cards[0]!).sort()).toEqual(CARD_KEYS);
		expect(cards[0]).toMatchObject({
			filename: 'file-5.pdf',
			title: 'File 5',
			fileSize: 1005,
			sourceType: 'upload',
			tags: ['finance'],
			autoTags: ['quarterly'],
			hasBytes: true,
		});
		expect(typeof cards[0]!.url).toBe('string');
		const encoded = JSON.stringify(convexToJson(cards as unknown as Value));
		expect(encoded).not.toContain('invoice delivery contract');

		// The legacy endpoint keeps the whole row for older clients.
		const legacy = await t.query(api.semanticFiles.listByContact, { contactId });
		expect(legacy[0]!.embedding).toHaveLength(1536);
		expect(legacy[0]!.extractedText).toBeTruthy();
		expect(typeof legacy[0]!.url).toBe('string');
	});

	it('gives a released file no URL', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		await linkedFile(t, contactId, 5, { released: true });

		const cards = await t.query(api.files.cards.listByContact, { contactId });
		expect(cards[0]).toMatchObject({ hasBytes: false, url: null });
	});

	it('names the conversation to a shared-inbox reader only', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		const threadId = await newThread(t);
		await linkedFile(t, contactId, 5, { threadId });
		await linkedFile(t, contactId, 4);

		const asOwner = await t.query(api.files.cards.listByContact, { contactId });
		expect(asOwner.map((c) => c.threadId)).toEqual([threadId, undefined]);
		expect(Object.keys(asOwner[1]!)).not.toContain('threadId');

		sessionMock.userId = 'member';
		sessionMock.role = 'editor';
		const asEditor = await t.query(api.files.cards.listByContact, { contactId });
		expect(asEditor).toHaveLength(2);
		for (const card of asEditor) expect(Object.keys(card)).not.toContain('threadId');
	});
});

describe('files.cards.listByContact — selection', () => {
	it('returns the newest 20 by default and honours 20 and 50, like the legacy list', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		for (const createdAt of shuffled(25)) await linkedFile(t, contactId, createdAt);
		// A junction row whose file is gone is skipped.
		const gone = await linkedFile(t, contactId, 99);
		await t.run((ctx) => ctx.db.delete(gone));

		const newest = (n: number) => Array.from({ length: n }, (_, i) => 25 - i);
		const byDefault = await t.query(api.files.cards.listByContact, { contactId });
		expect(byDefault.map((c) => c.createdAt)).toEqual(newest(20));
		const twenty = await t.query(api.files.cards.listByContact, { contactId, limit: 20 });
		expect(twenty.map((c) => c.createdAt)).toEqual(newest(20));
		const fifty = await t.query(api.files.cards.listByContact, { contactId, limit: 50 });
		expect(fifty.map((c) => c.createdAt)).toEqual(newest(25));

		for (const limit of [undefined, 20, 50]) {
			const legacy = await t.query(api.semanticFiles.listByContact, { contactId, limit });
			const cards = await t.query(api.files.cards.listByContact, { contactId, limit });
			expect(legacy.map((r) => r._id)).toEqual(cards.map((c) => c._id));
		}
	});

	it('fills the limit with older readable files when newer captures are hidden', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		for (const createdAt of [1, 2, 3]) await linkedFile(t, contactId, createdAt);
		// Newer Team Inbox captures: owners and admins only.
		for (const createdAt of [10, 11, 12]) {
			await linkedFile(t, contactId, createdAt, {
				sourceType: 'email_attachment',
				captureSource: 'team_inbox',
			});
		}

		sessionMock.userId = 'member';
		sessionMock.role = 'editor';
		const asEditor = await t.query(api.files.cards.listByContact, { contactId, limit: 2 });
		expect(asEditor.map((c) => c.createdAt)).toEqual([3, 2]);
		const legacy = await t.query(api.semanticFiles.listByContact, { contactId, limit: 2 });
		expect(legacy.map((r) => r.createdAt)).toEqual([3, 2]);

		sessionMock.userId = 'boss';
		sessionMock.role = 'owner';
		const asOwner = await t.query(api.files.cards.listByContact, { contactId, limit: 2 });
		expect(asOwner.map((c) => c.createdAt)).toEqual([12, 11]);
	});

	it('resolves a storage URL for the selected rows only', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		for (const createdAt of shuffled(25)) await linkedFile(t, contactId, createdAt);
		// The newest is released: selected, but there is nothing to resolve.
		await linkedFile(t, contactId, 30, { released: true });
		const owner: MutationSessionContext = {
			userId: 'boss',
			role: 'owner',
			activeOrganizationId: 'test-org',
		};

		await t.run(async (ctx) => {
			const getUrl = vi.fn((id: Id<'_storage'>) => ctx.storage.getUrl(id));
			const counted = Object.create(ctx, {
				storage: { value: { getUrl } satisfies StorageReader['storage'] },
			}) as typeof ctx;

			const cards = await listContactFileCards(counted, owner, contactId, 3);
			expect(cards.map((c) => c.createdAt)).toEqual([30, 25, 24]);
			expect(getUrl).toHaveBeenCalledTimes(2);

			const selected = await readableContactFiles(ctx, owner, contactId, 3);
			expect(selected.map((f) => f.createdAt)).toEqual([30, 25, 24]);
		});
	});

	it('reads a negative or NaN limit as none', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		await linkedFile(t, contactId, 1);

		expect(await t.query(api.files.cards.listByContact, { contactId, limit: -1 })).toEqual([]);
		expect(await t.query(api.files.cards.listByContact, { contactId, limit: NaN })).toEqual([]);
	});
});
