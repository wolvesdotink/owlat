/**
 * Shared shapes and loops for the contact-erasure phases (`phases.ts`,
 * `contentPhases.ts`).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id, TableNames } from '../../_generated/dataModel';
import type { ErasureBudget } from './budget';

/**
 * `walker` — one bounded transaction of a persisted job; may use one paginated
 * query and must stop when the budget runs out.
 * `inline` — the whole erasure inside the caller's transaction (organization
 * wipe, sample-data removal): unlimited budget, no pagination.
 */
export type ErasureMode = 'walker' | 'inline';

export interface PhaseContext {
	ctx: MutationCtx;
	contactId: Id<'contacts'>;
	budget: ErasureBudget;
	/** The phase's saved pagination cursor, when it uses one. */
	cursor: string | undefined;
	mode: ErasureMode;
}

export interface PhaseOutcome {
	isDone: boolean;
	/** Where to resume a paginated phase that is not done. */
	cursor?: string;
	/** A paginated query ran; Convex allows one per transaction. */
	isPaginated?: boolean;
}

export type PhaseRunner = (phase: PhaseContext) => Promise<PhaseOutcome>;

export const DONE: PhaseOutcome = { isDone: true };
export const NOT_DONE: PhaseOutcome = { isDone: false };

/**
 * Read `read(n)` repeatedly and hand every row to `each` until a read comes
 * back short (nothing left) or the budget runs out. `each` MUST take the row
 * out of the range `read` covers — delete it, or patch the indexed field — or
 * the loop would see it again. Returns whether the range is empty.
 */
export async function drainEach<Row>(
	budget: ErasureBudget,
	read: (limit: number) => Promise<Row[]>,
	each: (row: Row) => Promise<void>
): Promise<boolean> {
	while (!budget.isExhausted) {
		const limit = budget.chunk();
		const rows = await read(limit);
		for (const row of rows) {
			budget.charge(row);
			await each(row);
		}
		if (rows.length < limit) return true;
	}
	return false;
}

/** `drainEach` that deletes every row it reads. */
export function deleteAll<Row extends { _id: Id<TableNames> }>(
	{ ctx, budget }: PhaseContext,
	read: (limit: number) => Promise<Row[]>
): Promise<boolean> {
	return drainEach(budget, read, (row) => ctx.db.delete(row._id));
}

/**
 * Process the first row `first()` returns with `each` until none is left or
 * the budget runs out. For parents that need their own children drained
 * before they can go: `each` returns false when it ran out of budget midway,
 * leaving the row for the next transaction.
 */
export async function drainParents<Row>(
	budget: ErasureBudget,
	first: () => Promise<Row | null>,
	each: (row: Row) => Promise<boolean>
): Promise<PhaseOutcome> {
	while (!budget.isExhausted) {
		const row = await first();
		if (row === null) return DONE;
		budget.charge(row);
		if (!(await each(row))) return NOT_DONE;
	}
	return NOT_DONE;
}
