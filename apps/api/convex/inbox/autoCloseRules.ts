/**
 * Team Inbox auto-close: input bounds, when a waiting thread's quiet period
 * started, when it ends, and the column changes a status edge makes. Pure, so
 * the sweep, the reader query and the thread module share one definition.
 */

import type { Doc } from '../_generated/dataModel';

// The web settings form mirrors these bounds (apps/web utils/inboxAutoClose.ts).
const AUTO_CLOSE_MIN_DAYS = 1;
const AUTO_CLOSE_MAX_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The stored policy as the rules read it: off is `null`. */
export interface AutoClosePolicyView {
	quietDays: number;
	enabledAt: number;
}

/** Why `quietDays` cannot be saved, or `null` when it can. */
export function autoCloseDaysProblem(quietDays: number): string | null {
	if (
		!Number.isInteger(quietDays) ||
		quietDays < AUTO_CLOSE_MIN_DAYS ||
		quietDays > AUTO_CLOSE_MAX_DAYS
	) {
		return `Auto-close needs a whole number of days between ${AUTO_CLOSE_MIN_DAYS} and ${AUTO_CLOSE_MAX_DAYS}`;
	}
	return null;
}

/** The rule the sweep runs on, or `null` when auto-close is off. */
export function autoClosePolicyView(
	row: Pick<
		Doc<'inboxAutoClosePolicies'>,
		'isEnabled' | 'quietDays' | 'enabledAt' | 'updatedAt'
	> | null
): AutoClosePolicyView | null {
	if (!row?.isEnabled || autoCloseDaysProblem(row.quietDays)) return null;
	return { quietDays: row.quietDays, enabledAt: row.enabledAt ?? row.updatedAt };
}

type AutoCloseThread = Pick<
	Doc<'conversationThreads'>,
	| 'status'
	| 'lastMessageAt'
	| 'lastReplySentAt'
	| 'snoozedUntil'
	| 'snoozeReturnedAt'
	| 'waitingSince'
	| 'isAutoCloseDisabled'
	| 'autoCloseRestartedAt'
>;

/**
 * When the thread's current silence began: the latest of entering `waiting`,
 * the customer's last message, our last delivered reply, a snooze waking it
 * (on its own or by hand), the rule being switched on, and auto-close being
 * turned back on for it. A thread that waited before `waitingSince` existed
 * has only the others, and never less than the switch-on time.
 *
 * A snooze still on the row counts from its deadline: the snooze cron clears
 * it and stamps `snoozeReturnedAt` some time after that, so an auto-close run
 * in between must already see the wake, or it would close the thread without
 * the fresh quiet period the wake promises.
 */
export function quietSince(thread: AutoCloseThread, policy: AutoClosePolicyView): number {
	return Math.max(
		policy.enabledAt,
		thread.lastMessageAt,
		thread.waitingSince ?? 0,
		thread.lastReplySentAt ?? 0,
		thread.snoozeReturnedAt ?? 0,
		thread.snoozedUntil ?? 0,
		thread.autoCloseRestartedAt ?? 0
	);
}

/**
 * When the sweep may resolve the thread, or `null` when it never will in its
 * current state: auto-close is off, the thread is not waiting on the
 * customer, or a person turned it off for this thread.
 */
export function autoCloseDueAt(
	thread: AutoCloseThread,
	policy: AutoClosePolicyView | null
): number | null {
	if (!policy || thread.status !== 'waiting' || thread.isAutoCloseDisabled) return null;
	return quietSince(thread, policy) + policy.quietDays * DAY_MS;
}

/**
 * Due now. A snoozed thread never is: its quiet period starts at the snooze
 * deadline (see `quietSince`), and the rule's days are at least one.
 */
export function isAutoCloseDue(
	thread: AutoCloseThread,
	policy: AutoClosePolicyView | null,
	now: number
): boolean {
	const due = autoCloseDueAt(thread, policy);
	return due !== null && due <= now;
}

/** The newest `lastMessageAt` a thread due at `now` can have: the sweep's index bound. */
export function autoCloseCutoff(policy: AutoClosePolicyView, now: number): number {
	return now - policy.quietDays * DAY_MS;
}

type AutoCloseColumns = Partial<
	Pick<Doc<'conversationThreads'>, 'waitingSince' | 'autoClosedAt' | 'autoClosedQuietDays'>
>;

/**
 * The auto-close columns a real status edge moves: entering `waiting` starts
 * a fresh window, leaving it clears the stamp, and any edge out of an
 * automatic close ends its "closed automatically" provenance (when, and the
 * days the rule had then).
 */
export function autoCloseColumnsOnStatus(
	thread: Pick<
		Doc<'conversationThreads'>,
		'status' | 'waitingSince' | 'autoClosedAt' | 'autoClosedQuietDays'
	>,
	to: Doc<'conversationThreads'>['status'],
	now: number
): AutoCloseColumns {
	if (thread.status === to) return {};
	const patch: AutoCloseColumns = {};
	if (to === 'waiting') patch.waitingSince = now;
	else if (thread.waitingSince !== undefined) patch.waitingSince = undefined;
	if (thread.autoClosedAt !== undefined) patch.autoClosedAt = undefined;
	if (thread.autoClosedQuietDays !== undefined) patch.autoClosedQuietDays = undefined;
	return patch;
}
