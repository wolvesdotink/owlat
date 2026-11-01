/**
 * Reading Files (`semanticFiles`) as pages, and the compact card a list row
 * needs.
 *
 * A `semanticFiles` row carries its whole extraction: a 1,536-number
 * `embedding`, the staged-rebuild `secondaryEmbedding`, `extractedText` and
 * `searchableText`, none of which a list row needs. `files.cards.list` /
 * `search` page through the readers below, drop rows through
 * `readableFilesPage`, then project each survivor onto `SemanticFileCard`:
 * named fields only, so a column added to the table later stays out of the
 * card until someone puts it here. `readableContactFiles` selects the contact
 * list (`files.cards.listByContact`) the same way.
 *
 * Each reader owns one index, and each endpoint calls exactly one reader. A
 * pagination cursor belongs to the index that issued it, so an endpoint never
 * moves to another index: a source-filtered read is a new endpoint over a new
 * reader (`listFilesBySourcePage` / `searchFilesBySourcePage`), and the
 * unfiltered readers keep their index for the cursors already in flight.
 */

import { v, type Infer } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { MutationSessionContext } from './sessionOrganization';
import { batchGet } from '../_utils/batchLoader';
import { isSharedInboxReader } from '../inbox/access';
import { semanticFileSourceTypeValidator } from './literalValidators';
import { semanticFileReadGate } from './semanticFileAccess';

type SourceType = Infer<typeof semanticFileSourceTypeValidator>;

/** Minimal storage accessor: both query and mutation ctx satisfy it. */
export type StorageReader = { storage: { getUrl: (id: Id<'_storage'>) => Promise<string | null> } };

/**
 * Attach a resolved storage URL to a file row. Every reader returns files with a
 * `url`, so this one helper owns the `ctx.storage.getUrl(file.storageId)` hop.
 */
export async function hydrateFile(
	ctx: StorageReader,
	file: Doc<'semanticFiles'>
): Promise<Doc<'semanticFiles'> & { url: string | null }> {
	// A file whose bytes the retention sweep released has no URL. Readers
	// already type `url` as nullable, so this is a state, not an error.
	return { ...file, url: file.storageId ? await ctx.storage.getUrl(file.storageId) : null };
}

/** Hydrate a list of file rows with storage URLs, preserving order. */
export function hydrateFiles(
	ctx: StorageReader,
	files: Doc<'semanticFiles'>[]
): Promise<Array<Doc<'semanticFiles'> & { url: string | null }>> {
	return Promise.all(files.map((file) => hydrateFile(ctx, file)));
}

/** One page of files, newest first (`by_created_at`). */
export function listFilesPage(
	ctx: QueryCtx,
	paginationOpts: PaginationOptions
): Promise<PaginationResult<Doc<'semanticFiles'>>> {
	return ctx.db
		.query('semanticFiles')
		.withIndex('by_created_at')
		.order('desc')
		.paginate(paginationOpts);
}

/** One page of full-text matches over `search_files`, in relevance order. */
export function searchFilesPage(
	ctx: QueryCtx,
	query: string,
	paginationOpts: PaginationOptions
): Promise<PaginationResult<Doc<'semanticFiles'>>> {
	return ctx.db
		.query('semanticFiles')
		.withSearchIndex('search_files', (q) => q.search('searchableText', query))
		.paginate(paginationOpts);
}

/** One page of a single source's files, newest first (`by_source_and_created`). */
export function listFilesBySourcePage(
	ctx: QueryCtx,
	sourceType: SourceType,
	paginationOpts: PaginationOptions
): Promise<PaginationResult<Doc<'semanticFiles'>>> {
	return ctx.db
		.query('semanticFiles')
		.withIndex('by_source_and_created', (q) => q.eq('sourceType', sourceType))
		.order('desc')
		.paginate(paginationOpts);
}

/** One page of a single source's full-text matches over `search_files_by_source`. */
export function searchFilesBySourcePage(
	ctx: QueryCtx,
	query: string,
	sourceType: SourceType,
	paginationOpts: PaginationOptions
): Promise<PaginationResult<Doc<'semanticFiles'>>> {
	return ctx.db
		.query('semanticFiles')
		.withSearchIndex('search_files_by_source', (q) =>
			q.search('searchableText', query).eq('sourceType', sourceType)
		)
		.paginate(paginationOpts);
}

/**
 * Apply the `sourceType` provenance filter and the caller's read check to a
 * page of files. On the unfiltered readers both run after pagination
 * (mirroring `workspaces/mediaAssets.list`), so a page can come back sparse while
 * matching files sit on later pages. On the by-source readers the index has
 * already narrowed to the source and the check here is only a backstop. The
 * read gate can still leave a page short, or empty with more to load: a
 * function may paginate only once, so the client pages on (`isDone` decides,
 * not the row count). The cursor fields pass through untouched.
 */
export async function readableFilesPage(
	ctx: QueryCtx,
	session: MutationSessionContext,
	results: PaginationResult<Doc<'semanticFiles'>>,
	sourceType: SourceType | undefined
): Promise<PaginationResult<Doc<'semanticFiles'>>> {
	const canReadSemanticFile = semanticFileReadGate(ctx, session);
	const page: Doc<'semanticFiles'>[] = [];
	for (const file of results.page) {
		if (sourceType && file.sourceType !== sourceType) continue;
		if (await canReadSemanticFile(file)) page.push(file);
	}
	return { ...results, page };
}

/**
 * What a file card or table row shows. `hasBytes` is false once the retention
 * sweep released the blob (the row stays for retrieval); `url` is then null.
 */
const semanticFileCardFields = {
	_id: v.id('semanticFiles'),
	filename: v.string(),
	title: v.optional(v.string()),
	summary: v.optional(v.string()),
	mimeType: v.string(),
	fileSize: v.number(),
	tags: v.optional(v.array(v.string())),
	autoTags: v.optional(v.array(v.string())),
	sourceType: semanticFileSourceTypeValidator,
	version: v.number(),
	createdAt: v.number(),
	updatedAt: v.number(),
	hasBytes: v.boolean(),
	url: v.union(v.string(), v.null()),
};
export const semanticFileCardValidator = v.object(semanticFileCardFields);
export type SemanticFileCard = Infer<typeof semanticFileCardValidator>;

/** Project a readable row onto its card, resolving the storage URL. */
export async function toSemanticFileCard(
	ctx: StorageReader,
	file: Doc<'semanticFiles'>
): Promise<SemanticFileCard> {
	return {
		_id: file._id,
		filename: file.filename,
		title: file.title,
		summary: file.summary,
		mimeType: file.mimeType,
		fileSize: file.fileSize,
		tags: file.tags,
		autoTags: file.autoTags,
		sourceType: file.sourceType,
		version: file.version,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
		hasBytes: file.storageId !== undefined,
		url: file.storageId ? await ctx.storage.getUrl(file.storageId) : null,
	};
}

/** Project a gated page onto cards; the cursor fields pass through. */
export async function toSemanticFileCardPage(
	ctx: StorageReader,
	results: PaginationResult<Doc<'semanticFiles'>>
): Promise<PaginationResult<SemanticFileCard>> {
	return {
		...results,
		page: await Promise.all(results.page.map((file) => toSemanticFileCard(ctx, file))),
	};
}

/** How many files a contact list returns when the caller names no limit. */
export const CONTACT_FILES_DEFAULT_LIMIT = 20;

/**
 * The newest files linked to a contact that the caller may read, at most
 * `limit` (a negative or NaN limit reads as 0), newest first.
 *
 * Reads the `semanticFileContacts` junction by contact, sorts the linked rows
 * by `createdAt` (stable, so equal timestamps keep junction order), then runs
 * the read gate in that order and stops once `limit` rows passed it. Nothing
 * past the limit is gated, projected or given a storage URL.
 */
export async function readableContactFiles(
	ctx: QueryCtx,
	session: MutationSessionContext,
	contactId: Id<'contacts'>,
	limit: number = CONTACT_FILES_DEFAULT_LIMIT
): Promise<Doc<'semanticFiles'>[]> {
	const links = await ctx.db
		.query('semanticFileContacts')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: junction rows for one contact (files per person)
	const byId = await batchGet(
		ctx,
		links.map((link) => link.fileId)
	);
	const linked: Doc<'semanticFiles'>[] = [];
	const seen = new Set<string>();
	for (const link of links) {
		const file = byId.get(link.fileId);
		if (!file || seen.has(file._id)) continue;
		seen.add(file._id);
		linked.push(file);
	}
	linked.sort((a, b) => b.createdAt - a.createdAt);

	const max = Number.isNaN(limit) ? 0 : Math.max(0, Math.trunc(limit));
	const canReadSemanticFile = semanticFileReadGate(ctx, session);
	const readable: Doc<'semanticFiles'>[] = [];
	for (const file of linked) {
		if (readable.length >= max) break;
		if (await canReadSemanticFile(file)) readable.push(file);
	}
	return readable;
}

/**
 * A contact's file as a card, plus the conversation it came from so the Team
 * Answer attach menu can list this conversation's files first. `threadId`
 * follows the shared-inbox reader rule (`files/library.get`): any other member
 * gets the card without it.
 */
export const contactFileCardValidator = v.object({
	...semanticFileCardFields,
	threadId: v.optional(v.id('conversationThreads')),
});
export type ContactFileCard = Infer<typeof contactFileCardValidator>;

/** Project a readable row onto its contact card; `withThread` for shared-inbox readers only. */
export async function toContactFileCard(
	ctx: StorageReader,
	file: Doc<'semanticFiles'>,
	withThread: boolean
): Promise<ContactFileCard> {
	const card = await toSemanticFileCard(ctx, file);
	return withThread && file.threadId ? { ...card, threadId: file.threadId } : card;
}

/**
 * `files.cards.listByContact`: select with `readableContactFiles`, then project
 * only the selected rows, so a storage URL is resolved for those and no more.
 */
export async function listContactFileCards(
	ctx: QueryCtx,
	session: MutationSessionContext,
	contactId: Id<'contacts'>,
	limit: number | undefined
): Promise<ContactFileCard[]> {
	const files = await readableContactFiles(ctx, session, contactId, limit);
	const withThread = isSharedInboxReader(session);
	return Promise.all(files.map((file) => toContactFileCard(ctx, file, withThread)));
}
