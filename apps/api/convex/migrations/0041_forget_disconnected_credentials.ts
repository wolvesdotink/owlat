/**
 * Drop the stored password from external mail accounts that were disconnected
 * before disconnecting started dropping it.
 *
 * `mail/external/accountTeardown.ts` now clears the AES envelope whenever a
 * connection ends — the member disconnects, an admin removes the mailbox, a
 * seed is retired, a move archives the source. That only fires on the
 * TRANSITION, so every row disconnected before this shipped still carries a
 * decryptable IMAP/SMTP password for a mailbox nothing syncs. Those are exactly
 * the credentials the new promise says are gone.
 *
 * An operator runs `convex run migrations/0041_forget_disconnected_credentials:run`
 * once. It walks `externalMailAccounts` by status and patches away the four
 * `secret*` fields on every `disconnected` row. Idempotent: a row already
 * cleared is counted and left alone, so re-running is a no-op.
 *
 * Only `disconnected` rows are touched. A `pending`/`connected`/`error`/
 * `auth_error` account is one the mail-sync worker is expected to open a
 * connection for, and clearing its envelope would break a working mailbox.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { logInfo } from '../lib/runtimeLog';

/** Rows per page. Small enough to stay well inside a mutation's limits. */
const PAGE_SIZE = 100;

export const clearPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (
		ctx,
		args
	): Promise<{ cleared: number; alreadyClear: number; cursor: string; isDone: boolean }> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_status', (q) => q.eq('status', 'disconnected'))
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });

		let cleared = 0;
		let alreadyClear = 0;
		for (const account of page) {
			if (account.secretCiphertext === undefined) {
				alreadyClear++;
				continue;
			}
			await ctx.db.patch(account._id, {
				secretCiphertext: undefined,
				secretIv: undefined,
				secretAuthTag: undefined,
				secretEnvelopeVersion: undefined,
			});
			cleared++;
		}
		return { cleared, alreadyClear, cursor: continueCursor, isDone };
	},
});

export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ cleared: number; alreadyClear: number }> => {
		let cursor: string | null = null;
		let cleared = 0;
		let alreadyClear = 0;
		for (;;) {
			const page: { cleared: number; alreadyClear: number; cursor: string; isDone: boolean } =
				await ctx.runMutation(
					internal.migrations['0041_forget_disconnected_credentials'].clearPage,
					{ cursor }
				);
			cleared += page.cleared;
			alreadyClear += page.alreadyClear;
			if (page.isDone) break;
			cursor = page.cursor;
		}
		logInfo('migration.0041_forget_disconnected_credentials', { cleared, alreadyClear });
		return { cleared, alreadyClear };
	},
});
