/**
 * Renew repeated Block and accordion-section ids in saved emails (issue
 * #1083, migration 0055).
 *
 * Emails saved before duplication renewed descendant ids can hold two copies
 * of a composite Block that share ids: accordion headers in the sent email
 * toggle the other copy, and one translation overlay entry drives both copies.
 * `lib/repeatedBlockIds.ts` keeps the first occurrence of each id and renews
 * the later ones, copying each renewed Block's overlay entry in every language
 * so both copies keep the translation they have today.
 *
 *   npx convex run migrations/0055_repair_repeated_block_ids:run
 *
 * WHAT A REPAIRED ROW GETS, IN ONE PATCH: the new `content` and `translations`,
 * the next `contentRevision` (an editor still open on the old content has its
 * save refused instead of writing the repeated ids back), and
 * `htmlRenderState.stale`. The HTML is rendered in Node, which a mutation
 * cannot do, so the page queues the rows on the saved-block rerender pool
 * (ADR-0023), the same path a saved-block edit takes: the job renders the
 * default and translated HTML from the repaired row and writes it only while
 * the row is still at the repaired revision. Until then, sends use the HTML the
 * row already had, and publishing waits for the render. Rows without a
 * repeated id are not written. `updatedAt` is left alone: nobody edited the
 * email.
 *
 * SAFE AT ANY POINT, AND OPTIONAL: an unrepaired row behaves exactly as before.
 * Nothing waits on this.
 *
 * DURABLE AND RESUMABLE: `run` schedules the first page; each page is its own
 * mutation that schedules the next one, first through `emailTemplates`, then
 * through `transactionalEmails`. Progress and completion live in the migration
 * ledger (`migrationRuns` row `0055_repair_repeated_block_ids`,
 * lib/migrationLedger.ts): each page records its cursor and counts in the same
 * transaction as its writes, and the final page marks the row `completed`.
 * Running `run` again on an unfinished pass resumes it from the recorded
 * cursor and supersedes any chain still queued; on a finished one it does
 * nothing (`'{"restart":true}'` starts a fresh pass). Pages are idempotent: a
 * repaired row has no repeated id left, so redoing a page writes nothing.
 */

import { v } from 'convex/values';
import { generateId } from '@owlat/shared';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { logInfo, logWarn } from '../lib/runtimeLog';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { nextContentRevision } from '../lib/contentRevision';
import { repairRowRepeatedIds } from '../lib/repeatedBlockIds';
import { rerenderBlocksPool } from '../emailBlocks/renderingPool';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

const MIGRATION = '0055_repair_repeated_block_ids';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.7';

/**
 * Rows per page. A row carries its block JSON, translation overlays and the
 * rendered HTML of every language, so a page stays small to keep reads and
 * writes well under the transaction limits.
 */
const PAGE_SIZE = 10;

const TABLES = ['emailTemplates', 'transactionalEmails'] as const;
type Table = (typeof TABLES)[number];
const tableValidator = v.union(v.literal('emailTemplates'), v.literal('transactionalEmails'));

/**
 * The ledger keeps one cursor for the whole pass, so it names the table too:
 * `<table>:<that table's cursor>`, with an empty cursor for the table's start.
 */
function encodeCursor(table: Table, cursor: string | null): string {
	return `${table}:${cursor ?? ''}`;
}

function decodeCursor(stored: string | undefined): { table: Table; cursor: string | null } {
	if (!stored) return { table: TABLES[0], cursor: null };
	const separator = stored.indexOf(':');
	const table = TABLES.find((name) => name === stored.slice(0, separator));
	if (!table) throw new Error(`${MIGRATION}: unreadable ledger cursor "${stored}"`);
	return { table, cursor: stored.slice(separator + 1) || null };
}

type PageResult = {
	/** Where the next page starts, in ledger form. */
	cursor: string;
	isDone: boolean;
	scanned: number;
	repaired: number;
	/** The page belonged to a generation a later start or resume replaced; nothing ran. */
	isSuperseded?: boolean;
};

/** Repair one page of `table`; returns the ids it wrote. */
async function repairRows(
	ctx: MutationCtx,
	table: Table,
	cursor: string | null
): Promise<{
	repairedIds: Array<Id<'emailTemplates'> | Id<'transactionalEmails'>>;
	scanned: number;
	continueCursor: string;
	isDone: boolean;
}> {
	const { page, continueCursor, isDone } = await ctx.db
		.query(table)
		.paginate({ numItems: PAGE_SIZE, cursor });
	const repairedIds: Array<Id<'emailTemplates'> | Id<'transactionalEmails'>> = [];
	for (const row of page) {
		const repair = repairRowRepeatedIds(row, () => generateId());
		if (repair.kind === 'unchanged') continue;
		if (repair.kind === 'unreadable') {
			// Not JSON this repair can read: leave the row as it is and name it.
			logWarn(`migration.${MIGRATION}.unreadable`, { table, id: row._id, field: repair.field });
			continue;
		}
		await ctx.db.patch(row._id, {
			content: repair.content,
			...(repair.translations !== undefined && { translations: repair.translations }),
			contentRevision: nextContentRevision(row),
			htmlRenderState: { stale: true, failureCount: 0 },
		});
		repairedIds.push(row._id);
		logInfo(`migration.${MIGRATION}.repaired`, { table, id: row._id, ...repair.counts });
	}
	return { repairedIds, scanned: page.length, continueCursor, isDone };
}

/** Queue the HTML of the repaired rows on the saved-block rerender pool. */
async function queueRerender(
	ctx: MutationCtx,
	table: Table,
	ids: Array<Id<'emailTemplates'> | Id<'transactionalEmails'>>
): Promise<void> {
	if (ids.length === 0) return;
	const rows = {
		templateIds: table === 'emailTemplates' ? (ids as Id<'emailTemplates'>[]) : [],
		transactionalIds: table === 'transactionalEmails' ? (ids as Id<'transactionalEmails'>[]) : [],
	};
	await rerenderBlocksPool.enqueueAction(ctx, internal.emailBlocks.rendering.reRenderEmails, rows, {
		onComplete: internal.emailBlocks.renderingPool.onRerenderComplete,
		context: rows,
	});
}

/** Repair one page and schedule the next one, unless a later start superseded this chain. */
export const repairPage = internalMutation({
	args: {
		table: tableValidator,
		cursor: v.union(v.string(), v.null()),
		generation: v.number(),
	},
	handler: async (ctx, args): Promise<PageResult> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo(`migration.${MIGRATION}.superseded`, { generation: args.generation });
			return {
				cursor: encodeCursor(args.table, args.cursor),
				isDone: false,
				scanned: 0,
				repaired: 0,
				isSuperseded: true,
			};
		}

		const page = await repairRows(ctx, args.table, args.cursor);
		await queueRerender(ctx, args.table, page.repairedIds);

		// A finished table hands over to the next one, from its start.
		const nextTable = page.isDone ? TABLES[TABLES.indexOf(args.table) + 1] : undefined;
		const result: PageResult = {
			cursor: nextTable
				? encodeCursor(nextTable, null)
				: encodeCursor(args.table, page.continueCursor),
			isDone: page.isDone && !nextTable,
			scanned: page.scanned,
			repaired: page.repairedIds.length,
		};
		await recordMigrationPage(ctx, run, {
			cursor: result.cursor,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.repaired,
		});
		logInfo(`migration.${MIGRATION}.page`, {
			table: args.table,
			scanned: result.scanned,
			repaired: result.repaired,
			isDone: result.isDone,
			generation: run.generation,
		});
		if (!result.isDone) {
			const next = decodeCursor(result.cursor);
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0055_repair_repeated_block_ids'].repairPage,
				{ table: next.table, cursor: next.cursor, generation: run.generation }
			);
		}
		return result;
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor. A finished migration is left alone unless `restart` is set.
 */
export const run = internalMutation({
	args: { restart: v.optional(v.boolean()) },
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		const start = decodeCursor(begun.cursor);
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0055_repair_repeated_block_ids'].repairPage,
			{ table: start.table, cursor: start.cursor, generation: begun.generation }
		);
		logInfo(`migration.${MIGRATION}.started`, {
			table: start.table,
			generation: begun.generation,
			pageCount: begun.pageCount,
		});
		return { started: true, generation: begun.generation };
	},
});
