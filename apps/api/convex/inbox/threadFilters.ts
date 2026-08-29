/**
 * Team Inbox thread SLICES — the filter pills and the indexed query behind each
 * one.
 *
 * Lifted out of `inbox/queries.ts` when the "Waiting > 24h" pill pushed that
 * file past the ~500 LOC split guideline. It is also the natural seam: the
 * slice definition is what `listThreads` and `getThreadFilterCounts` MUST
 * share, because a pill whose count and list disagree is worse than no count.
 */

import { v, type Infer } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import { WAITING_OVER_24H_MS } from './threadSort';

/**
 * Team Inbox filter pills. Each value is one focused slice of the shared inbox:
 *   - open        active conversations, snoozed ones hidden until they wake
 *   - mine        assigned to me and still active (open/waiting)
 *   - unassigned  nobody owns it yet and still active (open/waiting)
 *   - waiting     waiting on the customer's reply
 *   - waiting-24h waiting on US for longer than a day (see ./threadSort)
 *   - snoozed     currently snoozed (returns automatically later)
 *   - resolved    marked resolved
 * Absent = every thread (used by the chat "link an inbox thread" picker).
 */
export const threadFilterValidator = v.union(
	v.literal('open'),
	v.literal('mine'),
	v.literal('unassigned'),
	v.literal('waiting'),
	v.literal('waiting-24h'),
	v.literal('snoozed'),
	v.literal('resolved')
);

/** How many rows a filter-count pill will read before rendering "99+". */
export const FILTER_COUNT_CAP = 100;

/** Derived from the validator, so the two can never drift apart. */
export type ThreadFilter = Infer<typeof threadFilterValidator>;

/**
 * Build the index-driven query for one filter pill. Every branch is indexed so
 * a filter change simply selects a different index — pagination and counts both
 * page cleanly without any O(all-threads) scan. Shared by `listThreads` and
 * `getThreadFilterCounts` so a pill's count and its list always agree.
 *
 * `undefined` filter = every thread (the chat link-thread picker), ordered by
 * recency.
 */
export function buildThreadQuery(
	ctx: QueryCtx,
	filter: ThreadFilter | undefined,
	userId: string,
	now: number
) {
	const base = ctx.db.query('conversationThreads');
	switch (filter) {
		case 'open':
			// Active conversations; a snoozed thread stays hidden until it wakes.
			return base
				.withIndex('by_status_and_last_message_at', (idx) => idx.eq('status', 'open'))
				.filter((f) =>
					f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
				);
		case 'waiting':
			// Waiting on the customer — also parks snoozed rows under Snoozed only.
			return base
				.withIndex('by_status_and_last_message_at', (idx) => idx.eq('status', 'waiting'))
				.filter((f) =>
					f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
				);
		case 'waiting-24h':
			// Waiting on US past the escalation. `lastMessageAt` only ever advances
			// on inbound activity (inbox/threads/module.ts), so the index range IS
			// the waiting time — no scan and no message join.
			return base
				.withIndex('by_status_and_last_message_at', (idx) =>
					idx.eq('status', 'open').lte('lastMessageAt', now - WAITING_OVER_24H_MS)
				)
				.filter((f) =>
					f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
				);
		case 'resolved':
			return base.withIndex('by_status_and_last_message_at', (idx) => idx.eq('status', 'resolved'));
		case 'mine':
			// Assigned to me, still active (open/waiting), not currently snoozed.
			return base
				.withIndex('by_assigned_to', (idx) => idx.eq('assignedTo', userId))
				.filter((f) =>
					f.and(
						f.or(f.eq(f.field('status'), 'open'), f.eq(f.field('status'), 'waiting')),
						f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
					)
				);
		case 'unassigned':
			return base
				.withIndex('by_assigned_to', (idx) => idx.eq('assignedTo', undefined))
				.filter((f) =>
					f.and(
						f.or(f.eq(f.field('status'), 'open'), f.eq(f.field('status'), 'waiting')),
						f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
					)
				);
		case 'snoozed':
			return base.withIndex('by_snoozed_until', (idx) => idx.gt('snoozedUntil', now));
		default:
			return base.withIndex('by_last_message_at');
	}
}
