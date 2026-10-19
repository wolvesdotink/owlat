/**
 * A file's version history, a page at a time.
 *
 * `semanticFiles.getVersionHistory` walks the whole `previousVersionId` chain
 * in one call and returns every version whole, embedding vectors and
 * extracted text included. `list` walks at most `VERSION_HISTORY_PAGE_BUDGET`
 * rows per call, applies the same `semanticFileReadGate` to each, and returns
 * the readable ones as `FileVersionRow`s: the fields a history row shows.
 *
 * The budget counts rows walked, not rows returned: a version the caller may
 * not read costs a step and is left out, so a page can come back short, or
 * empty with `isDone: false`, while permitted older versions wait behind the
 * cursor.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { semanticFileReadGate } from '../lib/semanticFileAccess';
import { walkVersionChain } from '../lib/semanticFileVersions';
import { throwInvalidInput } from '../_utils/errors';

/** Rows one call may read from the chain, readable or not. */
export const VERSION_HISTORY_PAGE_BUDGET = 20;

/** What a version history row shows; `url` is null once the bytes are released. */
const fileVersionRowValidator = v.object({
	_id: v.id('semanticFiles'),
	filename: v.string(),
	fileSize: v.number(),
	version: v.number(),
	changeSummary: v.optional(v.string()),
	createdAt: v.number(),
	url: v.union(v.string(), v.null()),
});
export type FileVersionRow = Infer<typeof fileVersionRowValidator>;

type StorageReader = { storage: { getUrl: (id: Id<'_storage'>) => Promise<string | null> } };

async function toFileVersionRow(
	ctx: StorageReader,
	file: Doc<'semanticFiles'>
): Promise<FileVersionRow> {
	return {
		_id: file._id,
		filename: file.filename,
		fileSize: file.fileSize,
		version: file.version,
		changeSummary: file.changeSummary,
		createdAt: file.createdAt,
		url: file.storageId ? await ctx.storage.getUrl(file.storageId) : null,
	};
}

/**
 * One page of `fileId`'s version history, newest first. Pass the previous
 * page's `continueCursor` as `cursor` to read further back. `isDone` is true
 * only when the chain has nothing further to walk; it is false whenever the
 * budget ran out with a predecessor still unread, and `continueCursor` then
 * points at it.
 */
export const list = authedQuery({
	args: {
		fileId: v.id('semanticFiles'),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.object({
		page: v.array(fileVersionRowValidator),
		isDone: v.boolean(),
		continueCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args, session) => {
		let startId = args.fileId;
		if (args.cursor) {
			const id = ctx.db.normalizeId('semanticFiles', args.cursor);
			if (!id) throwInvalidInput('Invalid version history cursor');
			startId = id;
		}
		const canReadSemanticFile = semanticFileReadGate(ctx, session);
		const { readable, next } = await walkVersionChain(
			ctx,
			startId,
			canReadSemanticFile,
			VERSION_HISTORY_PAGE_BUDGET
		);
		return {
			page: await Promise.all(readable.map((file) => toFileVersionRow(ctx, file))),
			isDone: next === null,
			continueCursor: next,
		};
	},
});
