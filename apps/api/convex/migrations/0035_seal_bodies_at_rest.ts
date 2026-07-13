/**
 * ADR-0035 / Sealed Mail E8b — seal every existing MESSAGE BODY at rest.
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
 * STORAGE BLOBS (raw `.eml` at `rawStorageId`, and the `*BodyStorageId` body
 * blobs) are served to clients and the MTA via SIGNED STORAGE URLS
 * (`ctx.storage.getUrl`), so sealing the bytes in place would hand ciphertext to
 * a plain download and regress delivery/IMAP FETCH. Sealing them safely needs a
 * decrypt-serving proxy; that is tracked as the follow-up and is intentionally
 * OUT of this migration. Bodies read into memory through
 * `readMailMessageText()` already unseal transparently, so a blob sealed by that
 * later step round-trips with no reader change.
 *
 * RESUMABLE: each table is walked one page at a time via a cursor-carrying
 * `internalMutation`; the `run` orchestrator (an `internalAction`) drives the
 * cursors to completion and can be re-invoked after an interrupt. Because
 * `sealAtRest` is idempotent (an already-sealed or empty value is returned
 * unchanged) and readers tolerate a mix of sealed and plaintext rows
 * (`openAtRest` passes plaintext through), NO row is ever unreadable mid-run and
 * re-running never double-seals.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getRequired } from '../lib/env';
import { sealAtRest } from '../lib/atRestBodies';
import { sealInboundBodyPatch, sealMailInlineBodyPatch } from '../lib/messageBody';

/** Rows per page. Small enough to stay well inside a mutation's limits. */
const PAGE_SIZE = 50;

const cursorArg = { cursor: v.union(v.string(), v.null()) };

interface PageResult {
	cursor: string;
	isDone: boolean;
	sealed: number;
}

/** Seal the inbound inline text/html body columns for one page. Field access
 * lives in `lib/messageBody.ts` (the body-layout owner); this applies the patch. */
export const sealInboundMessagesPage = internalMutation({
	args: cursorArg,
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('inboundMessages')
			.paginate({ numItems: PAGE_SIZE, cursor });
		let sealed = 0;
		for (const row of page) {
			const patch = await sealInboundBodyPatch(row);
			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(row._id, patch);
				sealed++;
			}
		}
		return { cursor: continueCursor, isDone, sealed };
	},
});

/** Seal the mailMessages inline text/html snippet columns for one page (inline
 * columns only — the body/eml storage blobs are handled separately; see header). */
export const sealMailMessagesPage = internalMutation({
	args: cursorArg,
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('mailMessages')
			.paginate({ numItems: PAGE_SIZE, cursor });
		let sealed = 0;
		for (const row of page) {
			const patch = await sealMailInlineBodyPatch(row);
			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(row._id, patch);
				sealed++;
			}
		}
		return { cursor: continueCursor, isDone, sealed };
	},
});

/** Seal `unifiedMessages.content` (the JSON body blob) for one page. */
export const sealUnifiedMessagesPage = internalMutation({
	args: cursorArg,
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const secret = getRequired('INSTANCE_SECRET');
		const { page, continueCursor, isDone } = await ctx.db
			.query('unifiedMessages')
			.paginate({ numItems: PAGE_SIZE, cursor });
		let sealed = 0;
		for (const row of page) {
			const next = await sealAtRest(secret, row.content);
			if (next !== row.content) {
				await ctx.db.patch(row._id, { content: next });
				sealed++;
			}
		}
		return { cursor: continueCursor, isDone, sealed };
	},
});

/** Seal `mailDrafts.bodyHtml` / `bodyText` / `bodyBlocks` for one page. */
export const sealMailDraftsPage = internalMutation({
	args: cursorArg,
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const secret = getRequired('INSTANCE_SECRET');
		const { page, continueCursor, isDone } = await ctx.db
			.query('mailDrafts')
			.paginate({ numItems: PAGE_SIZE, cursor });
		let sealed = 0;
		for (const row of page) {
			const patch: { bodyHtml?: string; bodyText?: string; bodyBlocks?: string } = {};
			const nextHtml = await sealAtRest(secret, row.bodyHtml);
			if (nextHtml !== row.bodyHtml) patch.bodyHtml = nextHtml;
			if (row.bodyText !== undefined) {
				const next = await sealAtRest(secret, row.bodyText);
				if (next !== row.bodyText) patch.bodyText = next;
			}
			if (row.bodyBlocks !== undefined) {
				const next = await sealAtRest(secret, row.bodyBlocks);
				if (next !== row.bodyBlocks) patch.bodyBlocks = next;
			}
			if (
				patch.bodyHtml !== undefined ||
				patch.bodyText !== undefined ||
				patch.bodyBlocks !== undefined
			) {
				await ctx.db.patch(row._id, patch);
				sealed++;
			}
		}
		return { cursor: continueCursor, isDone, sealed };
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
	handler: async (ctx): Promise<{ sealed: Record<string, number> }> => {
		const inbound = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealInboundMessagesPage, a)
		);
		const mail = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealMailMessagesPage, a)
		);
		const unified = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealUnifiedMessagesPage, a)
		);
		const drafts = await drainTable((a) =>
			ctx.runMutation(internal.migrations['0035_seal_bodies_at_rest'].sealMailDraftsPage, a)
		);
		return {
			sealed: {
				inboundMessages: inbound,
				mailMessages: mail,
				unifiedMessages: unified,
				mailDrafts: drafts,
			},
		};
	},
});
