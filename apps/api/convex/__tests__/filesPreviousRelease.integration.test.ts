/**
 * The previous release's Files paths (`semanticFiles:*` and
 * `semanticFileProcessing:*`) keep working against this release: each old path
 * takes the same arguments, declares the same result, keeps its auth floor,
 * and reads, writes and schedules what its moved function in `files/library`,
 * `files/pipeline` or `files/processing` does. Whatever an old path schedules
 * goes to the moved processing action.
 *
 * Timers are fake and never advanced, so a scheduled `processFile` is only
 * inspected, never run.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { __resetAiConfigCacheForTests } from '../lib/llmProvider';
import * as oldFiles from '../semanticFiles';
import * as oldProcessing from '../semanticFileProcessing';
import * as library from '../files/library';
import * as pipeline from '../files/pipeline';
import * as processing from '../files/processing';
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

type T = ReturnType<typeof convexTest>;

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

function setup(): { t: T; user: T } {
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

/** A file row without the fields two equal writes cannot share. */
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

describe('previous-release Files paths: shapes', () => {
	it('keep the builder kind, visibility, arguments and result of the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as {
				isQuery?: boolean;
				isMutation?: boolean;
				isAction?: boolean;
				isPublic?: boolean;
				isInternal?: boolean;
				exportArgs(): string;
				exportReturns(): string;
			};
			return {
				kind: [registered.isQuery, registered.isMutation, registered.isAction],
				visibility: [registered.isPublic, registered.isInternal],
				args: registered.exportArgs(),
				returns: registered.exportReturns(),
			};
		};
		const pairs: [unknown, unknown][] = [
			[oldFiles.get, library.get],
			[oldFiles.create, library.create],
			[oldFiles.ingest, library.ingest],
			[oldFiles.update, library.update],
			[oldFiles.remove, library.remove],
			[oldFiles.getInternal, pipeline.getInternal],
			[oldFiles.getByIds, pipeline.getByIds],
			[oldFiles.ftsRankedFileIds, pipeline.ftsRankedFileIds],
			[oldFiles.getProcessingContext, pipeline.getProcessingContext],
			[oldFiles.backfillUnprocessed, pipeline.backfillUnprocessed],
			[oldFiles.reprocessAfterAiConfigured, pipeline.reprocessAfterAiConfigured],
			[oldFiles.updateProcessedMetadata, pipeline.updateProcessedMetadata],
			[oldProcessing.processFile, processing.processFile],
			[oldProcessing.semanticSearch, processing.semanticSearch],
		];
		expect(pairs).toHaveLength(14);
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		// The create validator keeps every field the previous upload dialog sends.
		expect(Object.keys(JSON.parse(shape(oldFiles.create).args).value)).toHaveLength(12);
	});
});

describe('previous-release library paths', () => {
	it('semanticFiles:create inserts what files/library:create does and schedules the moved processing', async () => {
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

		const oldId = await user.mutation(api.semanticFiles.create, {
			...args,
			storageId: await uploadedBlob(t),
		});
		const newId = await user.mutation(api.files.library.create, {
			...args,
			storageId: await uploadedBlob(t),
		});

		expect(await row(t, oldId)).toEqual(await row(t, newId));
		expect(await row(t, oldId)).toMatchObject({ uploadedBy: 'user-1', title: 'Budget' });
		expect(await contactsOf(t, oldId)).toEqual([contactId]);
		expect(await scheduledNames(t)).toEqual([PROCESS_FILE, PROCESS_FILE]);
	});

	it('semanticFiles:get returns what files/library:get returns, thread subject for readers only', async () => {
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

		const asOwner = await user.query(api.semanticFiles.get, { fileId });
		expect(asOwner).toEqual(await user.query(api.files.library.get, { fileId }));
		expect(asOwner).toMatchObject({ threadId, threadSubject: 'Renewal terms' });
		expect(asOwner?.url).toEqual(expect.any(String));

		session.role = 'editor';
		const asEditor = await user.query(api.semanticFiles.get, { fileId });
		expect(asEditor).toEqual(await user.query(api.files.library.get, { fileId }));
		expect(asEditor?._id).toBe(fileId);
		expect(asEditor?.threadId).toBeUndefined();
		expect(asEditor?.threadSubject).toBeUndefined();
	});

	it('semanticFiles:update and remove edit and delete as files/library does', async () => {
		const { t, user } = setup();
		const contactId = await insertContact(t);
		const oldId = await insertFile(t);
		const newId = await insertFile(t);
		const edit = { title: 'Q3 budget', tags: ['finance', 'q3'], contactIds: [contactId] };

		await user.mutation(api.semanticFiles.update, { fileId: oldId, ...edit });
		await user.mutation(api.files.library.update, { fileId: newId, ...edit });
		expect(await row(t, oldId)).toEqual(await row(t, newId));
		expect((await row(t, oldId))?.searchableText).toContain('q3');
		expect(await contactsOf(t, oldId)).toEqual([contactId]);

		const { storageId } = (await t.run((ctx) => ctx.db.get(oldId)))!;
		await user.mutation(api.semanticFiles.remove, { fileId: oldId });
		expect(await row(t, oldId)).toBeNull();
		expect(await contactsOf(t, oldId)).toEqual([]);
		expect(await t.run(async (ctx) => await ctx.storage.get(storageId!))).toBeNull();
	});

	it('keep the owner/admin floor on the old write paths', async () => {
		const { t, user } = setup();
		const fileId = await insertFile(t);
		const storageId = await uploadedBlob(t);
		session.role = 'editor';

		await expect(
			user.mutation(api.semanticFiles.create, {
				storageId,
				filename: 'x.txt',
				mimeType: 'text/plain',
				fileSize: 1,
				sourceType: 'upload',
			})
		).rejects.toThrow(/Only owners and admins/);
		await expect(
			user.mutation(api.semanticFiles.update, { fileId, title: 'Renamed' })
		).rejects.toThrow(/Only owners and admins/);
		await expect(user.mutation(api.semanticFiles.remove, { fileId })).rejects.toThrow(
			/Admin access required/
		);

		expect(await t.run((ctx) => ctx.db.query('semanticFiles').collect())).toHaveLength(1);
		expect((await row(t, fileId))?.title).toBeUndefined();
		expect(await scheduledNames(t)).toEqual([]);
	});

	it('semanticFiles:ingest admits and refuses like files/library:ingest', async () => {
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

		const oldId = await t.mutation(internal.semanticFiles.ingest, {
			...args,
			storageId: await store(),
		});
		const newId = await t.mutation(internal.files.library.ingest, {
			...args,
			storageId: await store(),
		});
		expect(oldId).not.toBeNull();
		expect(await row(t, oldId!)).toEqual(await row(t, newId!));
		expect(await scheduledNames(t)).toEqual([PROCESS_FILE, PROCESS_FILE]);

		const executable = await store();
		const refused = await t.mutation(internal.semanticFiles.ingest, {
			...args,
			filename: 'payload.exe',
			mimeType: 'application/x-msdownload',
			storageId: executable,
		});
		expect(refused).toBeNull();
		expect(await t.run(async (ctx) => await ctx.storage.get(executable))).toBeNull();
		expect(await scheduledNames(t)).toHaveLength(2);
	});
});

describe('previous-release pipeline paths', () => {
	it('read what files/pipeline reads', async () => {
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

		const internalRead = await t.query(internal.semanticFiles.getInternal, { fileId });
		expect(internalRead).toEqual(await t.query(internal.files.pipeline.getInternal, { fileId }));
		expect(internalRead?._id).toBe(fileId);

		for (const mailCaptures of [undefined, 'none', 'all'] as const) {
			const byIds = { ids: [capture, fileId, previous], mailCaptures };
			const files = await t.query(internal.semanticFiles.getByIds, byIds);
			expect(files).toEqual(await t.query(internal.files.pipeline.getByIds, byIds));
			expect(files.map((file) => file._id)).toEqual(
				mailCaptures === 'all' ? [capture, fileId, previous] : [fileId, previous]
			);
		}

		const fts = { queryText: 'ABC-12345', limit: 10 };
		const ranked = await t.query(internal.semanticFiles.ftsRankedFileIds, fts);
		expect(ranked).toEqual(await t.query(internal.files.pipeline.ftsRankedFileIds, fts));
		expect([...ranked].sort()).toEqual([fileId, capture].sort());

		const context = { contactIds: [contactId], previousVersionId: previous };
		const processingContext = await t.query(internal.semanticFiles.getProcessingContext, context);
		expect(processingContext).toEqual(
			await t.query(internal.files.pipeline.getProcessingContext, context)
		);
		expect(processingContext).toMatchObject({
			contactNames: ['Ada Lovelace'],
			previousText: 'Last year: flat spend.',
		});
	});

	it('semanticFiles:updateProcessedMetadata commits what files/pipeline commits', async () => {
		const { t } = setup();
		const oldId = await insertFile(t);
		const newId = await insertFile(t);
		const processed = {
			title: 'Budget review',
			summary: 'Hosting spend rose.',
			extractedText: BODY,
			autoTags: ['hosting'],
			embedding: [],
			searchableText: `budget-review.txt ${BODY}`,
		};

		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId: oldId,
			...processed,
		});
		await t.mutation(internal.files.pipeline.updateProcessedMetadata, {
			fileId: newId,
			...processed,
		});
		expect(await row(t, oldId)).toEqual(await row(t, newId));
		expect(await row(t, oldId)).toMatchObject({ summary: 'Hosting spend rose.' });
	});

	it('the old backfill and reprocessing passes schedule the moved processing', async () => {
		const { t } = setup();
		await insertFile(t);
		expect(await t.mutation(internal.semanticFiles.backfillUnprocessed, {})).toEqual({
			scheduled: 0,
		});

		vi.stubEnv('LLM_API_KEY', 'sk-test');
		expect(await t.mutation(internal.semanticFiles.backfillUnprocessed, {})).toEqual(
			await t.mutation(internal.files.pipeline.backfillUnprocessed, {})
		);
		expect(await t.mutation(internal.semanticFiles.reprocessAfterAiConfigured, {})).toEqual({
			scheduled: 1,
		});
		expect(await scheduledNames(t)).toEqual([PROCESS_FILE, PROCESS_FILE, PROCESS_FILE]);
	});
});

describe('previous-release processing paths', () => {
	it('semanticFileProcessing:processFile stores what files/processing:processFile stores', async () => {
		const { t } = setup();
		const oldId = await insertFile(t);
		const newId = await insertFile(t);

		await t.action(internal.semanticFileProcessing.processFile, { fileId: oldId });
		await t.action(internal.files.processing.processFile, { fileId: newId });

		expect(await row(t, oldId)).toEqual(await row(t, newId));
		expect(await row(t, oldId)).toMatchObject({ extractedText: BODY, embedding: [] });
		expect((await row(t, oldId))?.searchableText).toContain('ABC-12345');
	});

	it('semanticFileProcessing:semanticSearch returns what files/processing:semanticSearch returns', async () => {
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
		const hits = await t.action(internal.semanticFileProcessing.semanticSearch, args);
		expect(hits).toEqual(await t.action(internal.files.processing.semanticSearch, args));
		expect(hits.map((hit) => hit.filename).sort()).toEqual(['exact.txt', 'near.txt']);
	});
});
