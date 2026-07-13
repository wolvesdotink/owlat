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
 * COLUMNS SEALED (string bodies):
 *   - inboundMessages : textBody, htmlBody          (AI-inbox inline bodies)
 *   - mailMessages    : textBodyInline, htmlBodyInline (personal-mailbox snippet)
 *   - unifiedMessages : content                      (the JSON body blob)
 *   - mailDrafts      : bodyHtml, bodyText, bodyBlocks (compose drafts)
 *
 * This back-fill seals the four INLINE body shapes of EXISTING rows. New rows
 * already seal at write time (`sealBodyAtWrite` at every production insert/patch)
 * and every reader decrypts through the accessor plane in `lib/messageBody.ts`,
 * so running this migration is the one-time step that catches up rows written
 * before sealing was live. It is idempotent and resumable, so re-running or
 * running it on an already-sealed table is a no-op.
 *
 * STORAGE BLOBS (raw `.eml` at `rawStorageId`, and the `*BodyStorageId` body
 * blobs) are NOT sealed here or at write. They are served to clients and the MTA
 * via SIGNED STORAGE URLS (`ctx.storage.getUrl`), so sealing the bytes in place
 * would hand ciphertext to a plain download and regress delivery/IMAP FETCH.
 * Sealing them safely needs a byte-level cipher (a binary `.eml` must not be
 * UTF-8 round-tripped) plus a server-side decrypt-serving path on the naked-URL
 * consumers (web reader, IMAP bridge, raw download) — a change that has to be
 * verified against a live instance, not CI. The in-memory reader path
 * (`readMailMessageText()`) already unseals transparently, so a blob sealed by
 * that later step round-trips with no reader change. See
 * `apps/docs/content/3.developer/21.sealed-mail-at-rest.md#storage-blobs`.
 *
 * SAFETY: this back-fill is a manually-invoked internal action (never auto-run on
 * deploy), matching the 0032–0034 convention; an operator runs `run` once.
 *
 * RESUMABLE: each table is walked one page at a time via a cursor-carrying
 * `internalMutation`; the `run` orchestrator (an `internalAction`) drives the
 * cursors to completion and can be re-invoked after an interrupt. Because
 * `sealMessageBody` is idempotent (an already-sealed or empty value is returned
 * unchanged) and readers tolerate a mix of sealed and plaintext rows
 * (`openAtRest` passes plaintext through), NO row is ever unreadable mid-run and
 * re-running never double-seals.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import {
	sealInboundBodyPatch,
	sealMailInlineBodyPatch,
	sealUnifiedContentPatch,
	sealMailDraftBodyPatch,
} from '../lib/messageBody';

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
		return { sealed: { inboundMessages, mailMessages, unifiedMessages, mailDrafts } };
	},
});
