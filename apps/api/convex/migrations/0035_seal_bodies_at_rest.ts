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
 *     EVERY row referencing the old blob (IMAP COPY shares one blob across rows —
 *     see `repointResealedBlobs`), then delete the old plaintext blob.
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
 * PLAINTEXT WRITE PATHS, RESEALED OUT-OF-BAND (no standing residual): a mutation
 * cannot read/re-store a blob's bytes (blob contents are action-only), so the two
 * paths that accept a worker-uploaded PLAINTEXT blob seal it via a scheduled
 * per-message action ({@link resealMessageBlobs}, `runAfter(0)`, idempotent):
 *   - `mail.imap.appendMessage` (IMAP APPEND uploads the raw `.eml` straight to
 *     storage) schedules the reseal after inserting the row.
 *   - `mail.externalDelivery.ingestExternalMessage` (external IMAP sync) already
 *     seals at write: its sole caller `ingestExternalRaw` is an ACTION that seals
 *     the raw `.eml` (`storeSealedBlob`) and the body blobs (`splitBodyForStorage`
 *     → `storeSealedBlob`) before the mutation runs, so nothing lands plaintext.
 * Between the plaintext write and the scheduled reseal, the blob reads/serves
 * correctly through the mixed-tolerance accessors + `/sealed-blob` proxy.
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
	type ActionCtx,
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

/**
 * Repoint EVERY row that references an old plaintext blob at its sealed copy,
 * then delete the old blob — atomically, in one mutation transaction, per column.
 *
 * SHARING-AWARE (the crux): IMAP COPY (`mail/imap.ts` copyMessages) shares a
 * storage blob across rows — the copy is a new `mailMessages` row spreading the
 * SAME `rawStorageId`/`textBodyStorageId`/`htmlBodyStorageId`. If we repointed
 * only the row we resealed and deleted the old blob, every sibling copy would be
 * left pointing at a deleted id — unreadable forever (`readSealedBlobBytes` →
 * `null`, `/sealed-blob` 404, IMAP `FETCH RFC822` empty). So for each column we
 * look up ALL rows referencing the old id (via the `by_*_storage` index) and
 * repoint them to the new sealed id BEFORE deleting the old blob. The primary
 * resealed row is among them (it still references the old id at call time).
 *
 * Doing repoint-and-delete in one mutation closes the orphan window: an interrupt
 * cannot leave a row pointing at the sealed copy while the old plaintext blob
 * lingers (a later re-run would then skip it, since its pointer is already
 * sealed). Mutations may delete storage (`dropBlob` in `ingestExternalMessage`
 * does too). Each `*StorageId` arg is the NEW sealed id; the paired
 * `old*StorageId` is the shared plaintext blob to drop.
 */
export const repointResealedBlobs = internalMutation({
	args: {
		rawStorageId: v.optional(v.id('_storage')),
		oldRawStorageId: v.optional(v.id('_storage')),
		textBodyStorageId: v.optional(v.id('_storage')),
		oldTextBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyStorageId: v.optional(v.id('_storage')),
		oldHtmlBodyStorageId: v.optional(v.id('_storage')),
	},
	handler: async (ctx, args) => {
		if (args.rawStorageId && args.oldRawStorageId) {
			const newId = args.rawStorageId;
			const oldId = args.oldRawStorageId;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', oldId))
				.collect();
			for (const r of rows) await ctx.db.patch(r._id, { rawStorageId: newId });
			await ctx.storage.delete(oldId);
		}
		if (args.textBodyStorageId && args.oldTextBodyStorageId) {
			const newId = args.textBodyStorageId;
			const oldId = args.oldTextBodyStorageId;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_text_body_storage', (q) => q.eq('textBodyStorageId', oldId))
				.collect();
			for (const r of rows) await ctx.db.patch(r._id, { textBodyStorageId: newId });
			await ctx.storage.delete(oldId);
		}
		if (args.htmlBodyStorageId && args.oldHtmlBodyStorageId) {
			const newId = args.htmlBodyStorageId;
			const oldId = args.oldHtmlBodyStorageId;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_html_body_storage', (q) => q.eq('htmlBodyStorageId', oldId))
				.collect();
			for (const r of rows) await ctx.db.patch(r._id, { htmlBodyStorageId: newId });
			await ctx.storage.delete(oldId);
		}
	},
});

/** The storage-blob ids of one mailMessages row (raw `.eml` required, body blobs
 * optional). Shared by the page walker and the per-message reseal action. */
interface MessageBlobIds {
	id: Id<'mailMessages'>;
	rawStorageId: Id<'_storage'>;
	textBodyStorageId?: Id<'_storage'>;
	htmlBodyStorageId?: Id<'_storage'>;
}

/**
 * Seal ONE message's storage blobs and repoint+delete atomically. Reseals the
 * raw `.eml` and both body blobs (each idempotent — an already-sealed blob
 * reseals to `null`), then, if anything changed, swaps the row's pointers and
 * drops the old plaintext originals in a single mutation. Returns `true` when a
 * blob was sealed. Shared by the back-fill page walker and the per-message
 * reseal scheduled after a plaintext-blob write path.
 */
async function resealRowBlobs(ctx: ActionCtx, row: MessageBlobIds): Promise<boolean> {
	const newRaw = await resealStoredBlob(ctx.storage, row.rawStorageId);
	const newText = row.textBodyStorageId
		? await resealStoredBlob(ctx.storage, row.textBodyStorageId)
		: null;
	const newHtml = row.htmlBodyStorageId
		? await resealStoredBlob(ctx.storage, row.htmlBodyStorageId)
		: null;
	if (!newRaw && !newText && !newHtml) return false;
	// Repoint EVERY row sharing each old blob AND drop the old plaintext blobs in
	// ONE mutation, so the old-blob delete is transactional with the pointer swap
	// across all sibling copies. An interrupt before this call leaves the rows on
	// the still-readable plaintext original (mixed tolerance) and a re-run reseals;
	// an interrupt cannot orphan a plaintext blob behind an already-sealed pointer,
	// nor a sibling copy behind a deleted blob, because all-or-nothing per column.
	await ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].repointResealedBlobs, {
		rawStorageId: newRaw ?? undefined,
		oldRawStorageId: newRaw ? row.rawStorageId : undefined,
		textBodyStorageId: newText ?? undefined,
		oldTextBodyStorageId: newText && row.textBodyStorageId ? row.textBodyStorageId : undefined,
		htmlBodyStorageId: newHtml ?? undefined,
		oldHtmlBodyStorageId: newHtml && row.htmlBodyStorageId ? row.htmlBodyStorageId : undefined,
	});
	return true;
}

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
			if (await resealRowBlobs(ctx, row)) sealed++;
		}
		return { cursor: next, isDone, sealed };
	},
});

/** The storage-blob ids of ONE mailMessages row (per-message reseal). */
export const mailMessageBlobIdsById = internalQuery({
	args: { id: v.id('mailMessages') },
	handler: async (ctx, { id }): Promise<MessageBlobIds | null> => {
		const m = await ctx.db.get(id);
		if (!m) return null;
		return {
			id: m._id,
			rawStorageId: m.rawStorageId,
			textBodyStorageId: m.textBodyStorageId,
			htmlBodyStorageId: m.htmlBodyStorageId,
		};
	},
});

/**
 * Seal ONE message's storage blobs at rest. Scheduled (`runAfter(0)`) from IMAP
 * APPEND (`mail.imap.appendMessage`), which uploads the raw `.eml` straight to
 * storage as plaintext — a mutation cannot read/re-store a blob's contents, so
 * the staged plaintext blob must be resealed out-of-band. (External IMAP sync
 * already seals at write via the `ingestExternalRaw` action, so it needs no
 * scheduled reseal.) Idempotent: a re-run over an already-sealed blob is a no-op,
 * so double-scheduling or a retry never corrupts the row.
 */
export const resealMessageBlobs = internalAction({
	args: { id: v.id('mailMessages') },
	handler: async (ctx, { id }): Promise<void> => {
		const row = await ctx.runQuery(
			internal.migrations['0035_seal_bodies_at_rest'].mailMessageBlobIdsById,
			{ id }
		);
		if (!row) return;
		await resealRowBlobs(ctx, row);
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
