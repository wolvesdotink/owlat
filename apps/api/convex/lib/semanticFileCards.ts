/**
 * Reading Files (`semanticFiles`) as pages, and the compact card a list row
 * needs.
 *
 * A `semanticFiles` row carries its whole extraction: a 1,536-number
 * `embedding`, the staged-rebuild `secondaryEmbedding`, `extractedText` and
 * `searchableText`. The legacy `semanticFiles.list` / `search` return every
 * row whole, so one page of 24 cards ships all of that to the browser for a
 * name, a size and a few tags. `files.cards.list` / `search` read the
 * same index, keep the same cursor and drop rows through the same read gate,
 * then project each survivor onto `SemanticFileCard`: named fields only, so a
 * column added to the table later stays out of the card until someone puts it
 * here.
 *
 * The page readers and `readableFilesPage` below are shared by both query
 * modules, so the legacy and the compact endpoint cannot drift apart on
 * which rows a caller sees or where a cursor points.
 */

import { v, type Infer } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { MutationSessionContext } from './sessionOrganization';
import { semanticFileSourceTypeValidator } from './literalValidators';
import { semanticFileReadGate } from './semanticFileAccess';

type SourceType = Infer<typeof semanticFileSourceTypeValidator>;

/** Minimal storage accessor: both query and mutation ctx satisfy it. */
export type StorageReader = { storage: { getUrl: (id: Id<'_storage'>) => Promise<string | null> } };

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

/**
 * Apply the `sourceType` provenance filter and the caller's read check to a
 * page of files. Both run after pagination (mirroring `mediaAssets.list`), so
 * a page can come back sparse while matching files sit on later pages; the
 * client loads further pages until the grid fills. The cursor fields pass
 * through untouched.
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
export const semanticFileCardValidator = v.object({
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
});
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
