/**
 * Sealed Mail E8b — seal every existing MESSAGE BODY at rest (migration 0035).
 *
 * Back-fills the sealing that `lib/atRestBodies.ts` applies going forward: it
 * walks the four body-bearing tables and replaces each plaintext body column
 * with the sealed envelope (`atrest:1:…`). After it completes, a database dump
 * holds ciphertext for these columns — the acceptance bar for E8b — while the
 * documented search-index exception (`mailMessages.snippet`, `searchableText`,
 * embedding vectors) stays plaintext so server-side search keeps working.
 *
 * INLINE BODY COLUMNS SEALED (DB strings, text cipher):
 *   - inboundMessages : textBody, htmlBody          (AI-inbox inline bodies)
 *   - mailMessages    : textBodyInline, htmlBodyInline (personal-mailbox snippet)
 *   - unifiedMessages : content                      (the JSON body blob)
 *   - mailDrafts      : bodyHtml, bodyText, bodyBlocks (compose drafts)
 *
 * STORAGE BLOBS SEALED (byte cipher):
 *   - mailMessages : rawStorageId (the raw `.eml`), textBodyStorageId,
 *     htmlBodyStorageId (the over-threshold body blobs). Sealed byte-for-byte
 *     (a binary `.eml` must not be UTF-8 round-tripped) via the blob cipher in
 *     `lib/atRestBodies.ts`. Because Convex storage is immutable per id, the
 *     blob pages read each blob, store the sealed copy under a new id, repoint
 *     the row, and delete the old plaintext blob.
 *
 * This back-fill catches up EXISTING rows. New rows already seal at write time
 * (`sealBodyAtWrite` for the inline columns and `storeSealedBlob` for the blobs,
 * at every production insert/patch), every in-process reader decrypts through
 * the accessor plane in `lib/messageBody.ts`, and the naked-URL blob consumers
 * (web reader, IMAP bridge, outbound MTA, raw download) fetch through the
 * `/sealed-blob` decrypt-serving proxy (`mail/sealedBlobHttp.ts`) — so a blob is
 * only ever plaintext on the wire to an authorized consumer, ciphertext at rest.
 * It is idempotent and resumable, so re-running or running it on an
 * already-sealed instance is a no-op.
 *
 * RESIDUAL (mixed-tolerated, not a write-path gap in acceptance): the
 * external-sync worker paths that UPLOAD a blob straight to storage
 * (`mail.imap.appendMessage`, `mail.externalDelivery.ingestExternalMessage`)
 * land it plaintext — a mutation cannot re-seal a blob (blob contents are
 * action-only). Those blobs are sealed by this back-fill and, until it runs,
 * read/serve correctly through the mixed-tolerance accessors + proxy.
 *
 * DOCUMENTED SEARCH EXCEPTION (stays plaintext on purpose): `mailMessages.snippet`,
 * the `searchableText` search fields, and embedding vectors — Convex indexes
 * plaintext; sealing them would break server-side search. They hold a
 * snippet/keywords, never the full body. Export decrypts (`contacts/dataExport.ts`).
 *
 * SAFETY: this back-fill is a manually-invoked internal action (never auto-run on
 * deploy), matching the 0032–0034 convention; an operator runs `run` once.
 *
 * RESUMABLE: each table is walked one page at a time (a cursor-carrying
 * `internalMutation` for the inline columns, an `internalAction` for the blobs);
 * the `run` orchestrator drives the cursors to completion and can be re-invoked
 * after an interrupt. Because sealing is idempotent (an already-sealed or empty
 * value / an already-sealed blob is skipped) and readers tolerate a mix of
 * sealed and plaintext rows and blobs (`openAtRest` / `openBytesAtRest` pass
 * plaintext through), NO row is ever unreadable mid-run and re-running never
 * double-seals.
 */

import { v } from 'convex/values';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import {
	sealInboundBodyPatch,
	sealMailInlineBodyPatch,
	sealUnifiedContentPatch,
	sealMailDraftBodyPatch,
} from '../lib/messageBody';
import { resealStoredBlob } from '../lib/sealedBlob';

/** Rows per page. Small enough to stay well inside a mutation's limits. */
const PAGE_SIZE = 50;

const cursorArg = { cursor: v.union(v.string(), v.null()) };

interface PageResult {
	cursor: string;
	isDone: boolean;
	sealed: number;
}

/** Per-table seal counts, named concretely so callers read `.inboundMessages`
 * rather than a `Record<string, number>` index-signature access. */
interface SealCounts {
	inboundMessages: number;
	mailMessages: number;
	unifiedMessages: number;
	mailDrafts: number;
	/** mailMessages rows whose STORAGE BLOBS (raw `.eml` + body blobs) were sealed. */
	mailBlobs: number;
}

/**
 * Seal one page of a body-bearing table: paginate, build each row's sealing
 * patch via the `lib/messageBody.ts` builder that owns that table's body-field
 * layout, apply only the changed columns, and count the rows touched. The patch
 * write is a closure over the caller's TYPED `ctx.db.patch`, so this generic
 * walker stays type-safe without naming any body field itself — the ratchet's
 * "body-field access lives only in messageBody.ts" invariant holds.
 */
async function sealPage<T extends TableNames, P extends object>(
	ctx: MutationCtx,
	table: T,
	cursor: string | null,
	buildPatch: (row: Doc<T>) => Promise<P>,
	applyPatch: (id: Id<T>, patch: P) => Promise<void>
): Promise<PageResult> {
	const { page, continueCursor, isDone } = await ctx.db
		.query(table)
		.paginate({ numItems: PAGE_SIZE, cursor });
	let sealed = 0;
	for (const row of page) {
		const patch = await buildPatch(row);
		if (Object.keys(patch).length > 0) {
			await applyPatch(row._id, patch);
			sealed++;
		}
	}
	return { cursor: continueCursor, isDone, sealed };
}

/** Seal the inbound inline text/html body columns for one page. */
export const sealInboundMessagesPage = internalMutation({
	args: cursorArg,
	handler: (ctx, { cursor }): Promise<PageResult> =>
		sealPage(ctx, 'inboundMessages', cursor, sealInboundBodyPatch, (id, patch) =>
			ctx.db.patch(id, patch)
		),
});

/** Seal the mailMessages inline text/html snippet columns for one page (inline
 * columns only — the body/eml storage blobs are handled separately; see header). */
export const sealMailMessagesPage = internalMutation({
	args: cursorArg,
	handler: (ctx, { cursor }): Promise<PageResult> =>
		sealPage(ctx, 'mailMessages', cursor, sealMailInlineBodyPatch, (id, patch) =>
			ctx.db.patch(id, patch)
		),
});

/** Seal `unifiedMessages.content` (the JSON body blob) for one page. */
export const sealUnifiedMessagesPage = internalMutation({
	args: cursorArg,
	handler: (ctx, { cursor }): Promise<PageResult> =>
		sealPage(ctx, 'unifiedMessages', cursor, sealUnifiedContentPatch, (id, patch) =>
			ctx.db.patch(id, patch)
		),
});

/** Seal `mailDrafts.bodyHtml` / `bodyText` / `bodyBlocks` for one page. */
export const sealMailDraftsPage = internalMutation({
	args: cursorArg,
	handler: (ctx, { cursor }): Promise<PageResult> =>
		sealPage(ctx, 'mailDrafts', cursor, sealMailDraftBodyPatch, (id, patch) =>
			ctx.db.patch(id, patch)
		),
});

// ── Storage-blob sealing (raw `.eml` + body blobs on mailMessages) ───────────
//
// The four pages above seal INLINE body columns (DB strings). The raw `.eml`
// (`rawStorageId`) and the over-threshold body blobs (`*BodyStorageId`) are
// separate STORAGE objects — sealing them means reading each blob's bytes,
// sealing them with the byte cipher, storing the sealed copy under a new id,
// pointing the row at it, and deleting the old plaintext blob. That needs an
// ACTION (blob contents are unreadable from a query/mutation), so it is a
// three-part page: a query yields the ids, `resealStoredBlob` does the crypto in
// the action, and a mutation patches the row. Idempotent + resumable:
// `resealStoredBlob` returns null for an already-sealed blob, so a re-run skips.

/** One page of mailMessages' storage-blob ids (raw + body blobs). */
export const mailMessageBlobPage = internalQuery({
	args: cursorArg,
	handler: async (ctx, { cursor }) => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('mailMessages')
			.paginate({ numItems: PAGE_SIZE, cursor });
		return {
			rows: page.map((m) => ({
				id: m._id,
				rawStorageId: m.rawStorageId,
				textBodyStorageId: m.textBodyStorageId,
				htmlBodyStorageId: m.htmlBodyStorageId,
			})),
			cursor: continueCursor,
			isDone,
		};
	},
});

/** Repoint one mailMessages row at its sealed blob copies (only changed ids). */
export const patchMailMessageBlobIds = internalMutation({
	args: {
		id: v.id('mailMessages'),
		rawStorageId: v.optional(v.id('_storage')),
		textBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyStorageId: v.optional(v.id('_storage')),
	},
	handler: async (ctx, args) => {
		const patch: {
			rawStorageId?: Id<'_storage'>;
			textBodyStorageId?: Id<'_storage'>;
			htmlBodyStorageId?: Id<'_storage'>;
		} = {};
		if (args.rawStorageId) patch.rawStorageId = args.rawStorageId;
		if (args.textBodyStorageId) patch.textBodyStorageId = args.textBodyStorageId;
		if (args.htmlBodyStorageId) patch.htmlBodyStorageId = args.htmlBodyStorageId;
		if (Object.keys(patch).length > 0) await ctx.db.patch(args.id, patch);
	},
});

/** Seal the storage blobs of one page of mailMessages. */
export const sealMailMessagesBlobsPage = internalAction({
	args: cursorArg,
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const {
			rows,
			cursor: next,
			isDone,
		} = await ctx.runQuery(internal.migrations['0035_seal_bodies_at_rest'].mailMessageBlobPage, {
			cursor,
		});
		let sealed = 0;
		for (const row of rows) {
			const newRaw = await resealStoredBlob(ctx.storage, row.rawStorageId);
			const newText = row.textBodyStorageId
				? await resealStoredBlob(ctx.storage, row.textBodyStorageId)
				: null;
			const newHtml = row.htmlBodyStorageId
				? await resealStoredBlob(ctx.storage, row.htmlBodyStorageId)
				: null;
			if (newRaw || newText || newHtml) {
				await ctx.runMutation(
					internal.migrations['0035_seal_bodies_at_rest'].patchMailMessageBlobIds,
					{
						id: row.id,
						rawStorageId: newRaw ?? undefined,
						textBodyStorageId: newText ?? undefined,
						htmlBodyStorageId: newHtml ?? undefined,
					}
				);
				// Only after the row points at the sealed copies do we delete the old
				// plaintext blobs — an interrupt before the patch leaves the row on the
				// still-readable original (mixed tolerance), never dangling.
				if (newRaw) await ctx.storage.delete(row.rawStorageId);
				if (newText && row.textBodyStorageId) await ctx.storage.delete(row.textBodyStorageId);
				if (newHtml && row.htmlBodyStorageId) await ctx.storage.delete(row.htmlBodyStorageId);
				sealed++;
			}
		}
		return { cursor: next, isDone, sealed };
	},
});

/**
 * Drive one table's paginated walker to completion. Extracted so `run` reads as
 * a list of tables and the interrupt/resume test can drive a single table's
 * cursor by hand.
 */
type PageRunner = (args: { cursor: string | null }) => Promise<PageResult>;

async function drainTable(runPage: PageRunner): Promise<number> {
	let cursor: string | null = null;
	let total = 0;
	for (;;) {
		const result: PageResult = await runPage({ cursor });
		total += result.sealed;
		if (result.isDone) break;
		cursor = result.cursor;
	}
	return total;
}

/**
 * Orchestrator: seal every body-bearing table. Idempotent and resumable — safe
 * to re-run after an interrupt; already-sealed rows are skipped.
 */
export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ sealed: SealCounts }> => {
		const inboundMessages = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealInboundMessagesPage, a)
		);
		const mailMessages = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealMailMessagesPage, a)
		);
		const unifiedMessages = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealUnifiedMessagesPage, a)
		);
		const mailDrafts = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealMailDraftsPage, a)
		);
		// Storage blobs (raw `.eml` + body blobs) — an action page, since blob
		// contents are only readable from an action.
		const mailBlobs = await drainTable((a) =>
			ctx.runAction(internal.migrations['0035_seal_bodies_at_rest'].sealMailMessagesBlobsPage, a)
		);
		return {
			sealed: { inboundMessages, mailMessages, unifiedMessages, mailDrafts, mailBlobs },
		};
	},
});
