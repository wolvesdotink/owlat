/**
 * Files as cards: the compact list and search the Files page and the Answer
 * mode file picker read.
 *
 * Same index, cursor, `sourceType` filter and read gate as
 * `semanticFiles.list` / `search` (lib/semanticFileCards.ts), but each row is
 * a `SemanticFileCard` instead of the whole document with its embedding
 * vectors and extracted text. The legacy queries stay as they are for N-1
 * clients and API callers.
 *
 * `listBySource` / `searchBySource` narrow to one source through their own
 * index before paginating, so a filtered page is a page of matches. They are
 * separate functions, not a branch inside `list` / `search`: a cursor belongs
 * to the index that issued it, and the clients already paging `list` /
 * `search` with a `sourceType` keep the post-pagination filter they started
 * with.
 */

import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { authedQuery } from '../lib/authedFunctions';
import { semanticFileSourceTypeValidator } from '../lib/literalValidators';
import {
	listFilesBySourcePage,
	listFilesPage,
	readableFilesPage,
	searchFilesBySourcePage,
	searchFilesPage,
	semanticFileCardValidator,
	toSemanticFileCardPage,
} from '../lib/semanticFileCards';

const cardPageValidator = paginationResultValidator(semanticFileCardValidator);

/** Files as cards (paginated, newest first) with an optional `sourceType` filter. */
// authz: readableFilesPage drops every file semanticFileReadGate refuses the caller.
export const list = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		sourceType: v.optional(semanticFileSourceTypeValidator),
	},
	returns: cardPageValidator,
	handler: async (ctx, args, session) => {
		const results = await listFilesPage(ctx, args.paginationOpts);
		const readable = await readableFilesPage(ctx, session, results, args.sourceType);
		return toSemanticFileCardPage(ctx, readable);
	},
});

/** Full-text search over Files as cards (paginated), with an optional `sourceType` filter. */
// authz: readableFilesPage drops every file semanticFileReadGate refuses the caller.
export const search = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		query: v.string(),
		sourceType: v.optional(semanticFileSourceTypeValidator),
	},
	returns: cardPageValidator,
	handler: async (ctx, args, session) => {
		const results = await searchFilesPage(ctx, args.query, args.paginationOpts);
		const readable = await readableFilesPage(ctx, session, results, args.sourceType);
		return toSemanticFileCardPage(ctx, readable);
	},
});

/** One source's files as cards (paginated, newest first), narrowed by index. */
// authz: readableFilesPage drops every file semanticFileReadGate refuses the caller.
export const listBySource = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		sourceType: semanticFileSourceTypeValidator,
	},
	returns: cardPageValidator,
	handler: async (ctx, args, session) => {
		const results = await listFilesBySourcePage(ctx, args.sourceType, args.paginationOpts);
		const readable = await readableFilesPage(ctx, session, results, args.sourceType);
		return toSemanticFileCardPage(ctx, readable);
	},
});

/** Full-text search over one source's files as cards (paginated), narrowed by index. */
// authz: readableFilesPage drops every file semanticFileReadGate refuses the caller.
export const searchBySource = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		query: v.string(),
		sourceType: semanticFileSourceTypeValidator,
	},
	returns: cardPageValidator,
	handler: async (ctx, args, session) => {
		const results = await searchFilesBySourcePage(
			ctx,
			args.query,
			args.sourceType,
			args.paginationOpts
		);
		const readable = await readableFilesPage(ctx, session, results, args.sourceType);
		return toSemanticFileCardPage(ctx, readable);
	},
});
