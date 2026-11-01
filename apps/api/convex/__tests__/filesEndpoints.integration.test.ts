/**
 * The Files library and processing endpoints (`files/library`,
 * `files/pipeline`, `files/processing`): what each reads, writes and
 * schedules, and the auth floor each keeps.
 *
 * Timers are fake and never advanced, so a scheduled `processFile` is only
 * inspected, never run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { __resetAiConfigCacheForTests } from '../lib/llmProvider';
import { recordUploadedBlob } from './uploadFixtures.testlib';
import { activeSpaceId, stampedIn } from './helpers/embeddingSpaces';
import { createTestContact } from './factories';

const session = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'editor' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const member = () => ({ userId: 'user-1', role: session.role, activeOrganizationId: 'org-1' });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => member()),
		getMutationContext: vi.fn(async () => member()),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => 'user-1'),
		// The adminMutation floor.
		requireAdminContext: vi.fn(async () => {
			if (session.role === 'editor') throw new Error('Admin access required');
			return member();
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');
const LLM_ENV_KEYS = ['LLM_PROVIDER', 'LLM_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
const PROCESS_FILE = 'files/processing:processFile';
const BODY = 'Quarterly budget review: hosting spend rose eleven percent, order ABC-12345.';

type T = TestConvex<typeof schema>;
type User = ReturnType<T['withIdentity']>;

beforeEach(() => {
	session.role = 'owner';
	vi.useFakeTimers();
	for (const key of LLM_ENV_KEYS) vi.stubEnv(key, undefined);
	__resetAiConfigCacheForTests();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	__resetAiConfigCacheForTests();
});

function setup(): { t: T; user: User } {
	const t = convexTest(schema, modules);
	return {
		t,
		user: t.withIdentity({ subject: 'user-1', issuer: 'test', tokenIdentifier: 'test|user-1' }),
	};
}

/** The scheduled functions, by name, in order. */
async function scheduledNames(t: T): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

async function uploadedBlob(t: T, text = BODY): Promise<Id<'_storage'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob([text])));
	await t.run((ctx) => recordUploadedBlob(ctx, storageId, 'user-1'));
	return storageId;
}

async function insertFile(
	t: T,
	fields: Partial<Doc<'semanticFiles'>> = {}
): Promise<Id<'semanticFiles'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob([BODY])));
	const now = Date.now();
	return await t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename: 'budget-review.txt',
			mimeType: 'text/plain',
			fileSize: BODY.length,
			sourceType: 'upload',
			tags: ['finance'],
			version: 1,
			embedding: [],
			searchableText: 'budget-review.txt finance',
			createdAt: now,
			updatedAt: now,
			...fields,
		})
	);
}

/** A file row without its ids and blob links. */
async function row(t: T, fileId: Id<'semanticFiles'>) {
	const file = await t.run((ctx) => ctx.db.get(fileId));
	if (!file) return null;
	const { _id, _creationTime, storageId, previousVersionId, ...rest } = file;
	return rest;
}

async function contactsOf(t: T, fileId: Id<'semanticFiles'>): Promise<Id<'contacts'>[]> {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('semanticFileContacts')
				.withIndex('by_file', (q) => q.eq('fileId', fileId))
				.collect()
		).map((link) => link.contactId)
	);
}

async function insertContact(t: T): Promise<Id<'contacts'>> {
	return await t.run((ctx) =>
		ctx.db.insert(
			'contacts',
			createTestContact({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' })
		)
	);
}

describe('library endpoints', () => {
	it('create inserts the file, links its contacts and schedules processing', async () => {
		const { t, user } = setup();
		const contactId = await insertContact(t);
		const args = {
			filename: 'budget-review.txt',
			mimeType: 'text/plain',
			fileSize: BODY.length,
			title: 'Budget',
			tags: ['finance'],
			contactIds: [contactId],
			sourceType: 'upload' as const,
		};

		const fileId = await user.mutation(api.files.library.create, {
			...args,
			storageId: await uploadedBlob(t),
		});

		expect(await row(t, fileId)).toMatchObject({ uploadedBy: 'user-1', title: 'Budget' });
		expect(await contactsOf(t, fileId)).toEqual([contactId]);
		expect(await scheduledNames(t)).toEqual([PROCESS_FILE]);
	});

	it('get returns the file, with the thread subject for shared-inbox readers only', async () => {
		const { t, user } = setup();
		const threadId = await t.run((ctx) =>
			ctx.db.insert('conversationThreads', {
				subject: 'Renewal terms',
				normalizedSubject: 'renewal terms',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 1,
				firstMessageAt: 1,
				lastMessageAt: 1,
				createdAt: 1,
			})
		);
		const fileId = await insertFile(t, { threadId });

		const asOwner = await user.query(api.files.library.get, { fileId });
		expect(asOwner).toMatchObject({ threadId, threadSubject: 'Renewal terms' });
		expect(asOwner?.url).toEqual(expect.any(String));

		session.role = 'editor';
		const asEditor = await user.query(api.files.library.get, { fileId });
		expect(asEditor?._id).toBe(fileId);
		expect(asEditor?.threadId).toBeUndefined();
		expect(asEditor?.threadSubject).toBeUndefined();
	});

	it('update edits the file and its contacts; remove deletes the row, the links and the blob', async () => {
		const { t, user } = setup();
		const contactId = await insertContact(t);
		const fileId = await insertFile(t);

		await user.mutation(api.files.library.update, {
			fileId,
			title: 'Q3 budget',
			tags: ['finance', 'q3'],
			contactIds: [contactId],
		});
		expect(await row(t, fileId)).toMatchObject({ title: 'Q3 budget', tags: ['finance', 'q3'] });
		expect((await row(t, fileId))?.searchableText).toContain('q3');
		expect(await contactsOf(t, fileId)).toEqual([contactId]);

		const { storageId } = (await t.run((ctx) => ctx.db.get(fileId)))!;
		await user.mutation(api.files.library.remove, { fileId });
		expect(await row(t, fileId)).toBeNull();
		expect(await contactsOf(t, fileId)).toEqual([]);
		expect(await t.run(async (ctx) => await ctx.storage.get(storageId!))).toBeNull();
	});

	it('keep the owner/admin floor on the writes', async () => {
		const { t, user } = setup();
		const fileId = await insertFile(t);
		const storageId = await uploadedBlob(t);
		session.role = 'editor';

		await expect(
			user.mutation(api.files.library.create, {
				storageId,
				filename: 'x.txt',
				mimeType: 'text/plain',
				fileSize: 1,
				sourceType: 'upload',
			})
		).rejects.toThrow(/Only owners and admins/);
		await expect(
			user.mutation(api.files.library.update, { fileId, title: 'Renamed' })
		).rejects.toThrow(/Only owners and admins/);
		await expect(user.mutation(api.files.library.remove, { fileId })).rejects.toThrow(
			/Admin access required/
		);

		expect(await t.run((ctx) => ctx.db.query('semanticFiles').collect())).toHaveLength(1);
		expect((await row(t, fileId))?.title).toBeUndefined();
		expect(await scheduledNames(t)).toEqual([]);
	});

	it('ingest admits a capture and schedules processing, and refuses an executable', async () => {
		const { t } = setup();
		const args = {
			filename: 'invoice.txt',
			mimeType: 'text/plain',
			fileSize: BODY.length,
			sourceType: 'email_attachment' as const,
			captureSource: 'team_inbox' as const,
			tags: ['inbound'],
		};
		const store = () => t.run((ctx) => ctx.storage.store(new Blob([BODY])));

		const fileId = await t.mutation(internal.files.library.ingest, {
			...args,
			storageId: await store(),
		});
		expect(fileId).not.toBeNull();
		expect(await row(t, fileId!)).toMatchObject({
			sourceType: 'email_attachment',
			captureSource: 'team_inbox',
		});
		expect(await scheduledNames(t)).toEqual([PROCESS_FILE]);

		const executable = await store();
		const refused = await t.mutation(internal.files.library.ingest, {
			...args,
			filename: 'payload.exe',
			mimeType: 'application/x-msdownload',
			storageId: executable,
		});
		expect(refused).toBeNull();
		expect(await t.run(async (ctx) => await ctx.storage.get(executable))).toBeNull();
		expect(await scheduledNames(t)).toHaveLength(1);
	});
});

describe('pipeline endpoints', () => {
	it('read a file, files by id with the mail-capture scope, full-text ranks and the processing context', async () => {
		const { t } = setup();
		const contactId = await insertContact(t);
		const previous = await insertFile(t, { extractedText: 'Last year: flat spend.' });
		const fileId = await insertFile(t, {
			searchableText: 'budget review ABC-12345',
			previousVersionId: previous,
			contactIds: [contactId],
		});
		const capture = await insertFile(t, {
			sourceType: 'email_attachment',
			captureSource: 'mailbox',
			searchableText: 'mailbox capture ABC-12345',
		});

		expect((await t.query(internal.files.pipeline.getInternal, { fileId }))?._id).toBe(fileId);

		for (const mailCaptures of [undefined, 'none', 'all'] as const) {
			const byIds = { ids: [capture, fileId, previous], mailCaptures };
			const files = await t.query(internal.files.pipeline.getByIds, byIds);
			expect(files.map((file) => file._id)).toEqual(
				mailCaptures === 'all' ? [capture, fileId, previous] : [fileId, previous]
			);
		}

		const fts = { queryText: 'ABC-12345', limit: 10 };
		const ranked = await t.query(internal.files.pipeline.ftsRankedFileIds, fts);
		expect([...ranked].sort()).toEqual([fileId, capture].sort());

		const context = { contactIds: [contactId], previousVersionId: previous };
		expect(await t.query(internal.files.pipeline.getProcessingContext, context)).toMatchObject({
			contactNames: ['Ada Lovelace'],
			previousText: 'Last year: flat spend.',
		});
	});

	it('updateProcessedMetadata commits the processed fields', async () => {
		const { t } = setup();
		const fileId = await insertFile(t);
		const processed = {
			title: 'Budget review',
			summary: 'Hosting spend rose.',
			extractedText: BODY,
			autoTags: ['hosting'],
			embedding: [],
			searchableText: `budget-review.txt ${BODY}`,
		};

		await t.mutation(internal.files.pipeline.updateProcessedMetadata, { fileId, ...processed });
		expect(await row(t, fileId)).toMatchObject({
			title: 'Budget review',
			summary: 'Hosting spend rose.',
			autoTags: ['hosting'],
		});
	});

	it('the backfill and reprocessing passes schedule processing once AI is configured', async () => {
		const { t } = setup();
		await insertFile(t);
		expect(await t.mutation(internal.files.pipeline.backfillUnprocessed, {})).toEqual({
			scheduled: 0,
		});

		vi.stubEnv('LLM_API_KEY', 'sk-test');
		expect(await t.mutation(internal.files.pipeline.backfillUnprocessed, {})).toEqual({
			scheduled: 1,
		});
		expect(await t.mutation(internal.files.pipeline.reprocessAfterAiConfigured, {})).toEqual({
			scheduled: 1,
		});
		expect(await scheduledNames(t)).toEqual([PROCESS_FILE, PROCESS_FILE]);
	});
});

describe('processing actions', () => {
	it('processFile without AI stores the extracted text and its search text', async () => {
		const { t } = setup();
		const fileId = await insertFile(t);

		await t.action(internal.files.processing.processFile, { fileId });

		expect(await row(t, fileId)).toMatchObject({ extractedText: BODY, embedding: [] });
		expect((await row(t, fileId))?.searchableText).toContain('ABC-12345');
	});

	it('semanticSearch fuses the vector and full-text legs and keeps contact-scoped files out', async () => {
		const { t } = setup();
		const spaceId = await activeSpaceId(t);
		const vector = (at: number) => Array.from({ length: 1536 }, (_, i) => (i === at ? 1 : 0));
		const contactId = await insertContact(t);
		await insertFile(t, {
			filename: 'near.txt',
			embedding: vector(3),
			...stampedIn(spaceId),
			searchableText: 'unrelated words',
		});
		await insertFile(t, {
			filename: 'exact.txt',
			embedding: vector(900),
			...stampedIn(spaceId),
			searchableText: 'order ABC-12345 shipped',
		});
		await insertFile(t, {
			filename: 'other-contact.txt',
			embedding: vector(3),
			...stampedIn(spaceId),
			contactIds: [contactId],
			searchableText: 'order ABC-12345 for another contact',
		});

		const args = {
			queryText: 'ABC-12345',
			embedding: vector(3),
			embeddingSpaceId: spaceId,
			scopeToContact: 'org-general-only' as const,
			limit: 10,
		};
		const hits = await t.action(internal.files.processing.semanticSearch, args);
		expect(hits.map((hit) => hit.filename).sort()).toEqual(['exact.txt', 'near.txt']);
	});
});
