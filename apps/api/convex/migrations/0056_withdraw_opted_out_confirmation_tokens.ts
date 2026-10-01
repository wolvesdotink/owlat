/**
 * Withdraw outstanding confirmation tokens for contacts who opted out before
 * the token-withdrawal change (migration 0056).
 *
 * A global opt-out now withdraws the contact's DOI confirmation token
 * (`doiLifecycle.withdrawConfirmationToken`), so a link minted before the
 * opt-out cannot lift it later, and the form submissions that waited on that
 * token are not carried to a later one. Contacts who opted out before that
 * change still hold the token they had then. This back-fill withdraws it with
 * the same semantics: the token and its expiry are cleared, `doiStatus` stays.
 *
 *   npx convex run migrations/0056_withdraw_opted_out_confirmation_tokens:run
 *
 * WHICH TOKENS: a contact with `unsubscribedAt` set whose token was minted at
 * or before that opt-out. Every token is minted with `DOI_TOKEN_TTL_MS`, so its
 * mint time is `doiTokenExpiresAt - DOI_TOKEN_TTL_MS`; a token without an
 * expiry predates expiries and counts as minted before. A token minted after
 * the opt-out belongs to a later signup that waits for a fresh confirmation,
 * and stays.
 *
 * DURABLE AND RESUMABLE: `run` schedules the first page; each page is its own
 * mutation that schedules the next one. Progress and completion live in the
 * migration ledger (`migrationRuns` row
 * `0056_withdraw_opted_out_confirmation_tokens`, lib/migrationLedger.ts): each
 * page records its cursor and counts in the same transaction as its writes,
 * and the final page marks the row `completed`. Running `run` again on an
 * unfinished pass resumes it and supersedes any chain still queued; on a
 * finished one it does nothing (`'{"restart":true}'` starts a fresh pass).
 * Pages are idempotent: a withdrawn token leaves the index range the walk
 * reads, so redoing a page changes nothing twice.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { DOI_TOKEN_TTL_MS, withdrawToken } from '../contacts/doiLifecycle';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

const MIGRATION = '0056_withdraw_opted_out_confirmation_tokens';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.7';

/** Token-holding contacts per page; each withdrawal is one small patch. */
const PAGE_SIZE = 200;

type PageResult = {
	cursor: string;
	isDone: boolean;
	scanned: number;
	withdrawn: number;
	/** The page belonged to a generation a later start or resume replaced; nothing ran. */
	isSuperseded?: boolean;
};

/**
 * Whether the contact still holds a token from before its global opt-out.
 * Exported for unit tests.
 */
export function holdsTokenFromBeforeOptOut(
	contact: Pick<Doc<'contacts'>, 'doiConfirmationToken' | 'doiTokenExpiresAt' | 'unsubscribedAt'>
): boolean {
	if (contact.doiConfirmationToken === undefined || contact.unsubscribedAt === undefined) {
		return false;
	}
	if (contact.doiTokenExpiresAt === undefined) return true;
	return contact.doiTokenExpiresAt - DOI_TOKEN_TTL_MS <= contact.unsubscribedAt;
}

/** Withdraw the pre-opt-out tokens among one page of token-holding contacts. */
async function withdrawPage(
	ctx: MutationCtx,
	cursor: string | null
): Promise<Omit<PageResult, 'isSuperseded'>> {
	// Only contacts that hold a token: every string sorts after a missing field.
	const { page, continueCursor, isDone } = await ctx.db
		.query('contacts')
		.withIndex('by_doi_confirmation_token', (q) => q.gte('doiConfirmationToken', ''))
		.paginate({ numItems: PAGE_SIZE, cursor });
	const now = Date.now();
	let withdrawn = 0;
	for (const contact of page) {
		if (!holdsTokenFromBeforeOptOut(contact)) continue;
		if (await withdrawToken(ctx, contact, now)) withdrawn++;
	}
	return { cursor: continueCursor, isDone, scanned: page.length, withdrawn };
}

/** Withdraw one page of tokens and schedule the next page of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<PageResult> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0056_withdraw_opted_out_confirmation_tokens.superseded', {
				generation: args.generation,
			});
			return {
				cursor: args.cursor ?? '',
				isDone: false,
				scanned: 0,
				withdrawn: 0,
				isSuperseded: true,
			};
		}

		const result = await withdrawPage(ctx, args.cursor);
		await recordMigrationPage(ctx, run, {
			cursor: result.cursor,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.withdrawn,
		});
		logInfo('migration.0056_withdraw_opted_out_confirmation_tokens.page', {
			scanned: result.scanned,
			withdrawn: result.withdrawn,
			isDone: result.isDone,
			generation: run.generation,
		});
		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0056_withdraw_opted_out_confirmation_tokens'].processPage,
				{ cursor: result.cursor, generation: run.generation }
			);
		}
		return result;
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor (or from `cursor` when given). A finished migration is left alone
 * unless `restart` is set.
 */
export const run = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		restart: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			cursor: args.cursor,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0056_withdraw_opted_out_confirmation_tokens'].processPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0056_withdraw_opted_out_confirmation_tokens.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
			pageCount: begun.pageCount,
		});
		return { started: true, generation: begun.generation };
	},
});
