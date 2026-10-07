/**
 * What hangs off a thread brief item or fact, cleared BEFORE the row itself
 * is deleted (review round 1, F4 and F5), as resumable ranges of the drain
 * (`purgeDrain.ts`); each handled row leaves its range:
 *
 *  - an item's activity rows and eval corrections are deleted; the
 *    commitment, team note and Postbox discussion message that link it lose
 *    the link (they are the user's or the team's and stay);
 *  - the items that point at it lose the pointer: one it replaced is open
 *    again (its counters move through `counters.ts writeItemChange`), one
 *    flagged as its possible duplicate is just unflagged;
 *  - the facts that point at a deleted fact lose the pointer, and the fact it
 *    superseded is current again.
 *
 * In a deleted thread (`isThreadGone`) every row of the thread goes anyway,
 * so only the links from outside the thread brief tables are cleared.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { writeItemChange } from './counters';
import { drainShrinking, type DrainBudget } from './purgeDrain';

/** Clear an item's links; false when the budget ran out first (call again). */
export async function drainItemLinks(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	budget: DrainBudget,
	opts: { isThreadGone: boolean }
): Promise<boolean> {
	const itemId = item._id;
	const steps: Array<() => Promise<boolean>> = [
		() =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('threadActivity')
						.withIndex('by_item', (q) => q.eq('itemId', itemId))
						.take(n),
				async (row) => {
					await ctx.db.delete(row._id);
					return true;
				}
			),
		() =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('threadItemCorrections')
						.withIndex('by_item', (q) => q.eq('itemId', itemId))
						.take(n),
				async (row) => {
					await ctx.db.delete(row._id);
					return true;
				}
			),
		() =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('mailCommitments')
						.withIndex('by_thread_item', (q) => q.eq('threadItemId', itemId))
						.take(n),
				async (row) => {
					await ctx.db.patch(row._id, { threadItemId: undefined });
					return true;
				}
			),
		() =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('threadNotes')
						.withIndex('by_thread_item', (q) => q.eq('threadItemId', itemId))
						.take(n),
				async (row) => {
					await ctx.db.patch(row._id, { threadItemId: undefined });
					return true;
				}
			),
		() =>
			drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('chatMessages')
						.withIndex('by_thread_item', (q) => q.eq('threadItemId', itemId))
						.take(n),
				async (row) => {
					await ctx.db.patch(row._id, { threadItemId: undefined });
					return true;
				}
			),
	];
	if (!opts.isThreadGone) {
		steps.push(
			() =>
				drainShrinking(
					budget,
					(n) =>
						ctx.db
							.query('threadItems')
							.withIndex('by_replaced_by', (q) => q.eq('replacedById', itemId))
							.take(n),
					async (row) => {
						// The claim that retired it is gone: it is open again.
						await writeItemChange(ctx, ref, row, {
							replacedById: undefined,
							...(row.status === 'superseded' ? { status: 'open' as const } : {}),
							revision: row.revision + 1,
							updatedAt: Date.now(),
						});
						return true;
					}
				),
			() =>
				drainShrinking(
					budget,
					(n) =>
						ctx.db
							.query('threadItems')
							.withIndex('by_duplicate_of', (q) => q.eq('possibleDuplicateOfId', itemId))
							.take(n),
					async (row) => {
						await ctx.db.patch(row._id, {
							possibleDuplicateOfId: undefined,
							revision: row.revision + 1,
							updatedAt: Date.now(),
						});
						return true;
					}
				)
		);
	}
	for (const step of steps) if (!(await step())) return false;
	return true;
}

/** Clear the pointers at a fact; false when the budget ran out first (call again). */
export async function drainFactLinks(
	ctx: MutationCtx,
	fact: Doc<'threadFacts'>,
	budget: DrainBudget,
	opts: { isThreadGone: boolean }
): Promise<boolean> {
	if (opts.isThreadGone) return true;
	const factId = fact._id;
	const now = Date.now();
	const isSupersedersClear = await drainShrinking(
		budget,
		(n) =>
			ctx.db
				.query('threadFacts')
				.withIndex('by_supersedes', (q) => q.eq('supersedesId', factId))
				.take(n),
		async (row) => {
			await ctx.db.patch(row._id, {
				supersedesId: undefined,
				revision: row.revision + 1,
				updatedAt: now,
			});
			return true;
		}
	);
	if (!isSupersedersClear) return false;
	const isConflictsClear = await drainShrinking(
		budget,
		(n) =>
			ctx.db
				.query('threadFacts')
				.withIndex('by_conflicts_with', (q) => q.eq('conflictsWithId', factId))
				.take(n),
		async (row) => {
			await ctx.db.patch(row._id, {
				conflictsWithId: undefined,
				revision: row.revision + 1,
				updatedAt: now,
			});
			return true;
		}
	);
	if (!isConflictsClear) return false;
	// The fact it superseded is current again: the claim that retired it is gone.
	if (fact.supersedesId) {
		const retired = await ctx.db.get(fact.supersedesId);
		budget.read(retired);
		if (retired && retired.status === 'superseded') {
			await ctx.db.patch(retired._id, {
				status: 'current',
				revision: retired.revision + 1,
				updatedAt: now,
			});
		}
	}
	return true;
}
