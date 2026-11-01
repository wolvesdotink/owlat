/**
 * Semantic Files: the previous release's paths.
 *
 * The Files library lives in `files/library.ts` and the processing pipeline's
 * reads and writes in `files/pipeline.ts`. The shims below keep their old
 * paths for one release: a Files page, file detail page or upload dialog in a
 * tab opened before the deploy calls `semanticFiles:*` by path; a previous
 * release's processing run or file search still in progress reads and commits
 * through the internal functions by their old paths; and a backfill or AI
 * reprocessing pass that release scheduled runs by its old path. Each shim
 * keeps its old path, builder, auth floor, arguments and result shape, and
 * runs the same body as its replacement. Remove after release 0.6.17.
 *
 * `list`, `search`, `getVersionHistory` and `listByContact` are the
 * whole-row reads older clients and API callers use; the web reads compact
 * cards and history pages from `files/cards.ts` and `files/history.ts`.
 */

import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import { internalQuery, type QueryCtx } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { authedQuery, authedMutation, adminMutation } from './lib/authedFunctions';
import { semanticFileReadGate } from './lib/semanticFileAccess';
import type { Id, Doc } from './_generated/dataModel';
import { semanticFileSourceTypeValidator } from './lib/literalValidators';
import { walkVersionChain } from './lib/semanticFileVersions';
import {
	hydrateFiles,
	listFilesPage,
	readableContactFiles,
	readableFilesPage,
	searchFilesPage,
} from './lib/semanticFileCards';
import {
	createFileArgs,
	createLibraryFile,
	ingestFile,
	ingestFileArgs,
	readLibraryFile,
	removeLibraryFile,
	updateFileArgs,
	updateLibraryFile,
} from './files/library';
import {
	backfillUnprocessedFiles,
	commitProcessedMetadata,
	ftsRankedFileIdsArgs,
	getByIdsArgs,
	processedMetadataArgs,
	processingContextArgs,
	rankFileIdsByText,
	readFileInternal,
	readFilesByIds,
	readProcessingContext,
	reprocessFilesAfterAiConfigured,
} from './files/pipeline';

// ============================================================
// Whole-row reads for older clients and API callers
// ============================================================

/**
 * Hydrate a gated page whole: the legacy list/search result, every column plus
 * `url`. Kept for N-1 clients and API callers; the web cards read the compact
 * `files.cards.list` / `search` over the same page and gate.
 */
async function hydratePage(
	ctx: QueryCtx,
	results: PaginationResult<Doc<'semanticFiles'>>
): Promise<PaginationResult<Doc<'semanticFiles'> & { url: string | null }>> {
	return { ...results, page: await hydrateFiles(ctx, results.page) };
}

/**
 * List files (paginated, newest first) with an optional `sourceType` filter.
 */
// authz: readableFilesPage drops every file semanticFileReadGate refuses the caller.
export const list = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		sourceType: v.optional(semanticFileSourceTypeValidator),
	},
	handler: async (ctx, args, session) => {
		const results = await listFilesPage(ctx, args.paginationOpts);
		return hydratePage(ctx, await readableFilesPage(ctx, session, results, args.sourceType));
	},
});

/**
 * Full-text search for files by content/title (paginated), with an optional
 * `sourceType` filter applied across the whole result set, not just one page.
 */
// authz: readableFilesPage drops every file semanticFileReadGate refuses the caller.
export const search = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		query: v.string(),
		sourceType: v.optional(semanticFileSourceTypeValidator),
	},
	handler: async (ctx, args, session) => {
		const results = await searchFilesPage(ctx, args.query, args.paginationOpts);
		return hydratePage(ctx, await readableFilesPage(ctx, session, results, args.sourceType));
	},
});

// Note: true semantic (vector) search for files lives on the action ctx, not
// the query ctx — it's the internalAction `files/processing.semanticSearch`,
// called by the agent (agent/steps/context_retrieval) and the assistant tools.
// There is intentionally no `semanticSearch` query here: a query can't run
// `ctx.vectorSearch`, so any such query would only return recency-ordered files
// while looking like semantic search — a trap. Callers wanting semantic file
// results must go through the action.

/**
 * Get version history for a file. Each version is read-checked on its own,
 * like `get`, so a chain cannot surface a version the caller may not read.
 *
 * Walks the whole chain (a loop in stored data stops at the first revisit) and
 * returns every readable version whole. The web reads compact pages from
 * `files.history.list`; this shape stays for older clients and API callers.
 */
export const getVersionHistory = authedQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args, session) => {
		const canReadSemanticFile = semanticFileReadGate(ctx, session);
		const { readable } = await walkVersionChain(ctx, args.fileId, canReadSemanticFile);
		return hydrateFiles(ctx, readable);
	},
});

/**
 * Get files related to a contact, those the caller may read: the newest
 * `limit` (default 20), whole rows with a storage URL. The web reads compact
 * cards from `files.cards.listByContact`; this shape stays for older clients
 * and API callers. Both select through `readableContactFiles`.
 */
// authz: readableContactFiles drops every file semanticFileReadGate refuses the caller.
export const listByContact = authedQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args, session) => {
		const files = await readableContactFiles(ctx, session, args.contactId, args.limit);
		return hydrateFiles(ctx, files);
	},
});

// ============================================================
// Previous-release paths of files/library.ts
// ============================================================

/** Remove after release 0.6.17; this release calls `files/library:get`. */
// authz: readLibraryFile applies semanticFileReadGate and the shared-inbox reader rule.
export const get = authedQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args, session) => await readLibraryFile(ctx, args.fileId, session),
});

/** Remove after release 0.6.17; this release calls `files/library:create`. */
// authz: createLibraryFile requires organization:manage (requirePermission).
export const create = authedMutation({
	args: createFileArgs,
	handler: async (ctx, args, session) => await createLibraryFile(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `files/library:ingest`. */
export const ingest = internalMutation({
	args: ingestFileArgs,
	handler: async (ctx, args): Promise<Id<'semanticFiles'> | null> => await ingestFile(ctx, args),
});

/** Remove after release 0.6.17; this release calls `files/library:update`. */
// authz: updateLibraryFile requires organization:manage (requirePermission).
export const update = authedMutation({
	args: updateFileArgs,
	handler: async (ctx, args, session) => await updateLibraryFile(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `files/library:remove`. */
export const remove = adminMutation({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => await removeLibraryFile(ctx, args.fileId),
});

// ============================================================
// Previous-release paths of files/pipeline.ts
// ============================================================

/** Remove after release 0.6.17; this release calls `files/pipeline:getInternal`. */
export const getInternal = internalQuery({
	args: { fileId: v.id('semanticFiles') },
	handler: async (ctx, args) => await readFileInternal(ctx, args.fileId),
});

/** Remove after release 0.6.17; this release calls `files/pipeline:getByIds`. */
export const getByIds = internalQuery({
	args: getByIdsArgs,
	handler: async (ctx, args) => await readFilesByIds(ctx, args),
});

/** Remove after release 0.6.17; this release calls `files/pipeline:ftsRankedFileIds`. */
export const ftsRankedFileIds = internalQuery({
	args: ftsRankedFileIdsArgs,
	handler: async (ctx, args): Promise<Id<'semanticFiles'>[]> => await rankFileIdsByText(ctx, args),
});

/** Remove after release 0.6.17; this release calls `files/pipeline:getProcessingContext`. */
export const getProcessingContext = internalQuery({
	args: processingContextArgs,
	handler: async (ctx, args) => await readProcessingContext(ctx, args),
});

/** Remove after release 0.6.17; this release schedules `files/pipeline:backfillUnprocessed`. */
export const backfillUnprocessed = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => await backfillUnprocessedFiles(ctx, args.limit),
});

/** Remove after release 0.6.17; this release schedules `files/pipeline:reprocessAfterAiConfigured`. */
export const reprocessAfterAiConfigured = internalMutation({
	args: {},
	handler: async (ctx) => await reprocessFilesAfterAiConfigured(ctx),
});

/** Remove after release 0.6.17; this release calls `files/pipeline:updateProcessedMetadata`. */
export const updateProcessedMetadata = internalMutation({
	args: processedMetadataArgs,
	handler: async (ctx, args) => await commitProcessedMetadata(ctx, args),
});
