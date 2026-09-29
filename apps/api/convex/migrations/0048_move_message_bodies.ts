/**
 * Move inline message bodies out of `mailMessages` (plan 3.2, migration 0048).
 *
 * New messages already write their inline text/html body to `mailMessageBodies`
 * (see `lib/messageBodyStore.ts`). This back-fill moves the bodies of rows
 * written before that change: each row with `textBodyInline` / `htmlBodyInline`
 * gets its body row and loses the two columns, so list, count and flag reads
 * stop paying for bodies they never show.
 *
 *   npx convex run migrations/0048_move_message_bodies:run
 *
 * SAFE AT ANY POINT: every reader resolves "body row, else the legacy columns",
 * so a half-moved table reads exactly like a fully moved one, and nothing is
 * unreadable mid-run. The insert and the column clear happen in one mutation.
 *
 * IDEMPOTENT AND RESUMABLE: a row without inline columns is skipped, and a row
 * that already has a body row only has its stale columns cleared, so re-running
 * after an interrupt (or on a finished instance) moves nothing twice. Pass the
 * `cursor` from a previous run's result to resume where it stopped.
 *
 * SEALING: moved values go through `sealBodyAtWrite`, exactly like a new write:
 * an already sealed value is kept verbatim, and a legacy plaintext value is
 * sealed when the instance has a key. The move never widens what a database
 * dump shows.
 *
 * ROLLBACK: code older than plan 3.2 reads bodies from the row only, so once
 * this has run, rolling the backend back would show moved messages without an
 * inline body. Run it once the release has settled, not in the same deploy.
 *
 * The legacy columns stay in the schema until this has run on every instance;
 * narrowing them away is the follow-up.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { moveLegacyInlineBody } from '../lib/messageBodyStore';
import { logInfo } from '../lib/runtimeLog';

/**
 * Rows per page. A legacy row carries up to 2 × 64 KB of inline body, which the
 * page reads once and writes once, so 25 rows stay well inside a mutation's
 * read and write limits.
 */
const PAGE_SIZE = 25;

type PageResult = { cursor: string; isDone: boolean; scanned: number; moved: number };

/** Move the inline bodies of one page of `mailMessages`. */
export const movePage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('mailMessages')
			.paginate({ numItems: PAGE_SIZE, cursor });
		let moved = 0;
		for (const row of page) {
			if (await moveLegacyInlineBody(ctx.db, row)) moved++;
		}
		return { cursor: continueCursor, isDone, scanned: page.length, moved };
	},
});

/**
 * Walk every message row to the end. Returns the totals and the last cursor,
 * which `run({ cursor })` accepts to resume an interrupted walk.
 */
export const run = internalAction({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (
		ctx,
		args
	): Promise<{ scanned: number; moved: number; cursor: string | null }> => {
		let cursor: string | null = args.cursor ?? null;
		let scanned = 0;
		let moved = 0;
		for (;;) {
			const result: PageResult = await ctx.runMutation(
				internal.migrations['0048_move_message_bodies'].movePage,
				{ cursor }
			);
			scanned += result.scanned;
			moved += result.moved;
			cursor = result.cursor;
			if (result.isDone) break;
		}
		logInfo('migration.0048_move_message_bodies', { scanned, moved });
		return { scanned, moved, cursor };
	},
});
