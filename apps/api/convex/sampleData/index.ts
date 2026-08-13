/**
 * Sample data for REAL installs — "explore with sample data", and the exact
 * removal that takes it back.
 *
 * The populated demo dataset used to be reachable only through
 * `POST /seed/demo`, which is fail-closed behind `OWLAT_DEV_MODE`. Turning that
 * flag on to give a self-hoster something to look at would also unlock
 * `POST /dev/reset` and disable BetterAuth rate limiting on a production
 * instance, so this path exists instead: the same loaders, minus the ones that
 * would create sign-ins nobody owns (see `SAMPLE_DATA_MODULES`), reachable on a
 * normal install and removable in one command.
 *
 * These are `internal*` functions — nothing here is on the public client API.
 * The operator-facing surface is `sampleData/manageHttp.ts`, authenticated with
 * `INSTANCE_SECRET` (the same on-box operator credential that creates the first
 * admin through `POST /seed/admin`).
 *
 * Installation is inert by construction: the loaders run with
 * `{ inert: true }`, so the fixture automation is written paused and the
 * fixture webhook disabled. Neither can act on the contacts the operator
 * actually cares about, and an operator who wants to watch them run has to
 * turn them on deliberately.
 *
 * Removal is exact by construction: it deletes rows carrying a seed tag and
 * nothing else, and re-checks the tag inside the delete transaction. A contact
 * the operator edited is still tagged and still goes; a contact they created is
 * untagged and stays.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import type { Id, TableNames } from '../_generated/dataModel';
import {
	applyLoaders,
	isRemovableSeedRow,
	pageSeedTaggedIds,
	SAMPLE_DATA_MODULES,
	SEEDED_TABLES,
} from '../seedDemo/pipeline';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';

/** Rows scanned per page. Well under the per-transaction read budget. */
export const SCAN_PAGE_SIZE = 512;

function assertSeededTable(table: string): TableNames {
	const known = SEEDED_TABLES.find((t) => t === table);
	if (!known) throw new Error(`Table '${table}' does not carry sample-data rows.`);
	return known;
}

/**
 * Insert the sample dataset. Idempotent: every loader dedupes on its natural
 * key (contact email, topic slug, domain, …) and reports the row as skipped.
 *
 * `{ inert: true }` is not optional here — it is the difference between demo
 * scenery and a live automation mailing the instance's next real signup.
 */
export const install = internalMutation({
	args: {},
	handler: async (
		ctx
	): Promise<{ inserted: Record<string, number>; skipped: Record<string, number> }> =>
		await applyLoaders(ctx, SAMPLE_DATA_MODULES, { inert: true }),
});

/** One page of seed-tagged row ids in one table. Read-only — see `pageSeedTaggedIds`. */
export const scanTaggedRows = internalQuery({
	args: {
		table: v.string(),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (
		ctx,
		{ table, cursor }
	): Promise<{ ids: string[]; cursor: string | null; isDone: boolean }> =>
		await pageSeedTaggedIds(ctx, assertSeededTable(table), cursor, SCAN_PAGE_SIZE),
});

/**
 * Delete previously scanned rows, re-checking the seed tag on each one. An id
 * that no longer resolves, or whose row lost its tag between scan and delete,
 * is left alone rather than removed on the strength of a stale read.
 */
export const deleteTaggedRows = internalMutation({
	args: {
		table: v.string(),
		ids: v.array(v.string()),
	},
	handler: async (ctx, { table, ids }): Promise<number> => {
		const known = assertSeededTable(table);
		let deleted = 0;
		for (const rawId of ids) {
			const id = ctx.db.normalizeId(known, rawId);
			if (!id) continue;
			const row = await ctx.db.get(id);
			if (!row || !isRemovableSeedRow(row)) continue;
			await deleteSeededRow(ctx, known, id);
			deleted++;
		}
		return deleted;
	},
});

/**
 * Delete one seed-tagged row, honouring its table's cascade contract.
 *
 * A bare `ctx.db.delete` is only correct for leaf rows. `contacts` and `topics`
 * are parents, and an operator exploring the sample data leaves rows of their
 * own hanging off them — an activity logged against a demo contact, that
 * contact enrolled in one of THEIR automations, one of their contacts
 * subscribed to a demo topic. Those children carry required foreign keys, so
 * dropping the parent alone strands them.
 *
 * The contact cascade is owned by `permanentlyDeleteContactWithRelations`
 * (`lib/contactMutations.ts`) — the same helper the retention cron uses, and
 * per `schema/contacts.ts` the only sanctioned place that cascade lives. The
 * topic cascade mirrors `topics.remove`: memberships, then the topic.
 *
 * `decrementCount: false` because the seed loaders never incremented
 * `instanceSettings.contactCount` in the first place; decrementing here would
 * push the operator's own contact count below the truth.
 */
async function deleteSeededRow(
	ctx: MutationCtx,
	table: TableNames,
	id: Id<TableNames>
): Promise<void> {
	if (table === 'contacts') {
		// Narrowing `table` does not narrow the id's phantom table type; the
		// branch is the guarantee.
		await permanentlyDeleteContactWithRelations(ctx, id as Id<'contacts'>, {
			decrementCount: false,
		});
		return;
	}

	if (table === 'topics') {
		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', id as Id<'topics'>))
			.collect(); // bounded: one topic's memberships (cascade)
		for (const membership of memberships) {
			await ctx.db.delete(membership._id);
		}
	}

	await ctx.db.delete(id);
}
