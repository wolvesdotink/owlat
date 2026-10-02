/**
 * The Team Inbox list's response-target slices and order.
 *
 *   - `sla-overdue`:  the running deadline has passed.
 *   - `sla-due-soon`: it passes within {@link SLA_DUE_SOON_MS}.
 *
 * Both walk `by_response_due_at`, so a page comes back most urgent first. A
 * running deadline only exists on an open, un-snoozed thread (a snooze or a
 * Waiting status pauses the clock, resolving ends it), so neither slice needs
 * a status clause. The Anyone / Me / Unassigned control narrows them like the
 * status tabs. `inbox/threadFilters.ts` dispatches here; the predicate mirrors
 * the index range for the text-search path.
 */

import type { QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';

/**
 * How close a deadline counts as "due soon".
 *
 * MIRRORED in apps/web/app/utils/inboxSla.ts, which paints the row chip's
 * due-soon tier; the two must agree or the pill and the chips disagree.
 */
export const SLA_DUE_SOON_MS = 60 * 60 * 1000;

export type SlaSlice = 'sla-overdue' | 'sla-due-soon';

export function isSlaSlice(filter: string | undefined): filter is SlaSlice {
	return filter === 'sla-overdue' || filter === 'sla-due-soon';
}

/** The indexed query behind one slice, narrowed to an assignment when given. */
export function buildSlaThreadQuery(
	ctx: QueryCtx,
	slice: SlaSlice,
	userId: string,
	now: number,
	assignee?: 'me' | 'unassigned'
) {
	const ranged = ctx.db
		.query('conversationThreads')
		.withIndex('by_response_due_at', (q) =>
			slice === 'sla-overdue'
				? q.gt('responseDueAt', 0).lte('responseDueAt', now)
				: q.gt('responseDueAt', now).lte('responseDueAt', now + SLA_DUE_SOON_MS)
		);
	if (!assignee) return ranged;
	const owner = assignee === 'me' ? userId : undefined;
	return ranged.filter((f) => f.eq(f.field('assignedTo'), owner));
}

/** The same slice as a predicate over a loaded row (the search path). */
export function threadMatchesSlaSlice(
	thread: Pick<Doc<'conversationThreads'>, 'responseDueAt' | 'assignedTo'>,
	slice: SlaSlice,
	userId: string,
	now: number,
	assignee?: 'me' | 'unassigned'
): boolean {
	if (assignee && thread.assignedTo !== (assignee === 'me' ? userId : undefined)) return false;
	const due = thread.responseDueAt;
	if (due === undefined) return false;
	return slice === 'sla-overdue' ? due <= now : due > now && due <= now + SLA_DUE_SOON_MS;
}

/**
 * `Array#sort` comparator for the "due first" order: the earliest deadline
 * leads, threads without a running clock follow, oldest activity first.
 */
export function compareResponseDue(
	a: Pick<Doc<'conversationThreads'>, 'responseDueAt' | 'lastMessageAt'>,
	b: Pick<Doc<'conversationThreads'>, 'responseDueAt' | 'lastMessageAt'>
): number {
	if (a.responseDueAt !== undefined && b.responseDueAt !== undefined) {
		return a.responseDueAt - b.responseDueAt;
	}
	if (a.responseDueAt !== undefined) return -1;
	if (b.responseDueAt !== undefined) return 1;
	return a.lastMessageAt - b.lastMessageAt;
}
