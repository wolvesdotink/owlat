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
 * cursor. Outside the budget, a call reads the origin once more when it
 * redeems a cursor, and the version just past the budget once to confirm it
 * still exists before offering a cursor to it.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { semanticFileReadGate } from '../lib/semanticFileAccess';
import { walkVersionChain } from '../lib/semanticFileVersions';
import { throwInvalidInput } from '../_utils/errors';
import {
	openVersionHistoryCursor,
	sealVersionHistoryCursor,
	type VersionHistoryCursorBinding,
} from './historyCursor';

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

const EMPTY_HISTORY = { page: [], isDone: true, continueCursor: null };

/** The one answer to every cursor that does not continue this caller's history. */
function throwInvalidCursor(): never {
	throwInvalidInput('Invalid version history cursor');
}

/**
 * One page of `fileId`'s version history, newest first. Pass the previous
 * page's `continueCursor` as `cursor` to read further back. `isDone` is true
 * only when the chain has nothing further to walk; it is false whenever the
 * budget ran out with a predecessor still unread. `continueCursor` is then an
 * opaque token (files/historyCursor.ts) that only this caller can redeem, and
 * only together with the same `fileId`; it is null without INSTANCE_SECRET.
 *
 * `fileId` must be a version the caller may read: otherwise the history is
 * empty and done, and any cursor is refused. Every cursor that is not one this
 * caller was given for this `fileId` (malformed, empty, tampered, or minted
 * for another history or another caller) is refused with the same error, so
 * a cursor cannot probe for documents. A genuine cursor whose version was
 * deleted since it was issued ends the history: an empty, done page. Only the
 * caller it was issued to, for this history, can get that answer.
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
		const canReadSemanticFile = semanticFileReadGate(ctx, session);
		const hasCursor = args.cursor !== undefined && args.cursor !== null;
		const origin = await ctx.db.get(args.fileId);
		if (!origin || !(await canReadSemanticFile(origin))) {
			if (hasCursor) throwInvalidCursor();
			return EMPTY_HISTORY;
		}
		const binding: VersionHistoryCursorBinding = {
			organizationId: session.activeOrganizationId,
			userId: session.userId,
			originId: origin._id,
		};

		let startId = origin._id;
		if (hasCursor) {
			const sealed = await openVersionHistoryCursor(binding, args.cursor!);
			const id = sealed === null ? null : ctx.db.normalizeId('semanticFiles', sealed);
			if (!id) throwInvalidCursor();
			startId = id;
		}

		const { readable, next } = await walkVersionChain(
			ctx,
			startId,
			canReadSemanticFile,
			VERSION_HISTORY_PAGE_BUDGET
		);
		return {
			page: await Promise.all(readable.map((file) => toFileVersionRow(ctx, file))),
			isDone: next === null,
			continueCursor: next === null ? null : await sealVersionHistoryCursor(binding, next),
		};
	},
});
