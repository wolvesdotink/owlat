/**
 * Seal thread brief fact keys (final review, migration 0068).
 *
 *   npx convex run migrations/0068_seal_fact_keys:run
 *
 * `threadFacts.factKey` held the model-derived key (entity, attribute,
 * context) in plaintext. Facts now carry `factKeyHash` (a keyed hash, what
 * matching compares) and a sealed `factKeyLabel` (mail/interpret/factKeys.ts).
 * This walk converts every row that still has the plaintext field: it writes
 * the hash and the sealed label and clears `factKey`. A redacted fact's opaque
 * `redacted:<id>` key becomes its hash, with no label.
 *
 * STEPPING STONE: readers accept both shapes for this release
 * (`factKeys.rowFactKeyHash` / `rowFactKeyLabel`); the release after this one
 * drops `factKey` from the schema once the walk has finished.
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0068_seal_fact_keys`, lib/migrationLedger.ts). Running
 * `run` again on an unfinished walk resumes it; on a finished one it does
 * nothing (`'{"restart":true}'` starts over). Pages are idempotent: a
 * converted row has no `factKey` left to convert.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';
import { storedFactKey } from '../mail/interpret/factKeys';

export const MIGRATION = '0068_seal_fact_keys';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.12';
/** Facts per page (each one is a hash and a seal). */
const PAGE_SIZE = 100;

/** The patch that converts one row, or null when it has nothing plaintext left. */
export async function sealedKeyPatch(
	row: Pick<Doc<'threadFacts'>, 'factKey' | 'factKeyHash'>
): Promise<Partial<Doc<'threadFacts'>> | null> {
	if (row.factKey === undefined) return null;
	if (row.factKey.startsWith('redacted:')) {
		return {
			factKeyHash: row.factKeyHash ?? row.factKey,
			factKeyLabel: undefined,
			factKey: undefined,
		};
	}
	return { ...(await storedFactKey(row.factKey)), factKey: undefined };
}

async function page(ctx: MutationCtx, cursor: string | null) {
	const result = await ctx.db.query('threadFacts').paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const row of result.page) {
		const patch = await sealedKeyPatch(row);
		if (!patch) continue;
		await ctx.db.patch(row._id, patch);
		changed++;
	}
	return { ...result, scanned: result.page.length, changed };
}

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0068_seal_fact_keys.superseded', { generation: args.generation });
			return { isDone: false, isSuperseded: true };
		}
		const result = await page(ctx, args.cursor);
		await recordMigrationPage(ctx, run, {
			cursor: result.continueCursor,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0068_seal_fact_keys.page', {
			scanned: result.scanned,
			changed: result.changed,
			isDone: result.isDone,
			generation: run.generation,
		});
		if (!result.isDone) {
			await ctx.scheduler.runAfter(0, internal.migrations['0068_seal_fact_keys'].processPage, {
				cursor: result.continueCursor,
				generation: run.generation,
			});
		}
		return { isDone: result.isDone };
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
		await ctx.scheduler.runAfter(0, internal.migrations['0068_seal_fact_keys'].processPage, {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		logInfo('migration.0068_seal_fact_keys.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
