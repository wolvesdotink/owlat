/**
 * The Team Inbox response clock: pure rules over a thread's SLA columns
 * (`lib/validators/inboxSla.ts` → `conversationThreadSlaFields`).
 *
 * A clock STARTS when a customer message arrives and no reply is already
 * owed. A first-response target applies until the team has replied once, the
 * next-response target after that. Further customer messages never move a
 * running deadline: the oldest unanswered message sets it, so "any news?" does
 * not buy the team more time.
 *
 * A clock ENDS three ways:
 *   - a reply goes out (manual reply, approved draft, autonomous send, team
 *     follow-up): judged met or missed against the deadline;
 *   - the thread is resolved or closed, or every message since the team's
 *     last reply turns out to need none (informational, archived,
 *     quarantined; `./threadClock.ts`): not judged,
 *     unless the deadline had already passed, which stays a miss;
 *   - targets are switched off: not judged.
 *
 * A clock PAUSES while the thread is snoozed or waiting on the customer: the
 * remaining opening time is stored and the deadline moves out by the pause
 * when it resumes. Internal actions (assigning, drafting, notes) never touch
 * it.
 *
 * Each function returns the PATCH to merge into the thread write, with
 * `undefined` for a cleared column; an empty object means nothing changes.
 */

import type { Doc } from '../../_generated/dataModel';
import { addBusinessMs, businessMsBetween, type SlaCalendar } from './businessHours';

export interface SlaPolicyView {
	firstResponseMs: number;
	nextResponseMs: number;
	calendar: SlaCalendar;
}

export type ThreadClock = Pick<
	Doc<'conversationThreads'>,
	| 'status'
	| 'latestDraftStatus'
	| 'snoozedUntil'
	| 'responseDueAt'
	| 'responseDueKind'
	| 'responseClockStartedAt'
	| 'responsePausedRemainingMs'
	| 'slaBreachNotifiedAt'
	| 'firstResponseAt'
	| 'resolvedAt'
	| 'slaMetCount'
	| 'slaMissedCount'
>;

export type ClockPatch = Partial<
	Pick<
		Doc<'conversationThreads'>,
		| 'responseDueAt'
		| 'responseDueKind'
		| 'responseClockStartedAt'
		| 'responsePausedRemainingMs'
		| 'slaBreachNotifiedAt'
		| 'firstResponseAt'
		| 'resolvedAt'
		| 'slaMetCount'
		| 'slaMissedCount'
	>
>;

const CLEARED: ClockPatch = {
	responseDueAt: undefined,
	responseDueKind: undefined,
	responseClockStartedAt: undefined,
	responsePausedRemainingMs: undefined,
	slaBreachNotifiedAt: undefined,
};

/** Is a reply owed right now (running or paused)? */
export function isClockSet(thread: ThreadClock): boolean {
	return thread.responseDueAt !== undefined || thread.responsePausedRemainingMs !== undefined;
}

/**
 * Has the team never answered this thread? `firstResponseAt` is the record;
 * a `sent` draft status covers threads answered before the column existed.
 */
function isAwaitingFirstReply(thread: ThreadClock): boolean {
	return thread.firstResponseAt === undefined && thread.latestDraftStatus !== 'sent';
}

/** Start a clock at `at` unless one is already owed. */
export function startClock(
	thread: ThreadClock,
	at: number,
	policy: SlaPolicyView | null
): ClockPatch {
	if (!policy || isClockSet(thread)) return {};
	const kind = isAwaitingFirstReply(thread) ? 'first' : 'next';
	const due = addBusinessMs(
		at,
		kind === 'first' ? policy.firstResponseMs : policy.nextResponseMs,
		policy.calendar
	);
	if (due === null) return {};
	return {
		responseDueAt: due,
		responseDueKind: kind,
		responseClockStartedAt: at,
		responsePausedRemainingMs: undefined,
		slaBreachNotifiedAt: undefined,
	};
}

/**
 * Start a clock at `at` on a thread that may be snoozed at `now`: a snoozed
 * thread gets the clock paused right away, with the opening time left from
 * `now`, so it runs again when the thread wakes.
 */
export function startClockOnThread(
	thread: ThreadClock,
	at: number,
	now: number,
	policy: SlaPolicyView | null
): ClockPatch {
	const patch = startClock(thread, at, policy);
	const isSnoozed = thread.snoozedUntil !== undefined && thread.snoozedUntil > now;
	if (patch.responseDueAt === undefined || !isSnoozed) return patch;
	return { ...patch, ...pauseClock({ ...thread, ...patch }, now, policy) };
}

/**
 * A customer message arrived: resume a paused clock, or start one. A message
 * reopens a resolved thread, so its resolve time no longer stands.
 */
export function clockOnInbound(
	thread: ThreadClock,
	at: number,
	policy: SlaPolicyView | null
): ClockPatch {
	const reopened: ClockPatch = thread.resolvedAt !== undefined ? { resolvedAt: undefined } : {};
	if (thread.responsePausedRemainingMs !== undefined) {
		return { ...reopened, ...resumeClock(thread, at, policy) };
	}
	return { ...reopened, ...startClock(thread, at, policy) };
}

/**
 * A reply went out at `at`: close the clock and judge it. With targets off
 * (`policy` null) the reply is recorded but not judged.
 */
export function clockOnReply(
	thread: ThreadClock,
	at: number,
	policy: SlaPolicyView | null
): ClockPatch {
	// Nothing owed and the first reply already on record: a second report of
	// the same send (channel replies are recorded twice) changes nothing.
	if (!isClockSet(thread) && thread.firstResponseAt !== undefined && thread.firstResponseAt <= at) {
		return {};
	}
	const patch: ClockPatch = {
		...CLEARED,
		firstResponseAt: Math.min(thread.firstResponseAt ?? at, at),
	};
	const verdict = policy ? judge(thread, at) : null;
	if (verdict === 'met') patch.slaMetCount = (thread.slaMetCount ?? 0) + 1;
	if (verdict === 'missed') patch.slaMissedCount = (thread.slaMissedCount ?? 0) + 1;
	return patch;
}

/**
 * The clock ends without a reply (resolved, closed, nothing left to answer,
 * targets off). A deadline that had already passed stays a miss.
 */
export function stopClock(thread: ThreadClock, now: number): ClockPatch {
	if (!isClockSet(thread)) return {};
	const patch: ClockPatch = { ...CLEARED };
	if (judge(thread, now) === 'missed') {
		patch.slaMissedCount = (thread.slaMissedCount ?? 0) + 1;
	}
	return patch;
}

/** Met, missed, or nothing owed — by the running deadline or the paused remainder. */
function judge(thread: ThreadClock, at: number): 'met' | 'missed' | null {
	if (thread.responseDueAt !== undefined) return at <= thread.responseDueAt ? 'met' : 'missed';
	if (thread.responsePausedRemainingMs !== undefined) {
		return thread.responsePausedRemainingMs > 0 ? 'met' : 'missed';
	}
	return null;
}

/** Snoozed or waiting on the customer: keep the remaining opening time. */
export function pauseClock(
	thread: ThreadClock,
	now: number,
	policy: SlaPolicyView | null
): ClockPatch {
	const due = thread.responseDueAt;
	if (due === undefined) return {};
	const remaining =
		due <= now ? due - now : policy ? businessMsBetween(now, due, policy.calendar) : due - now;
	return { responseDueAt: undefined, responsePausedRemainingMs: remaining };
}

/**
 * Back from a pause: the deadline is the remaining opening time from now. An
 * overdue remainder resumes as overdue by the same amount. With targets off
 * there is nothing to resume.
 */
export function resumeClock(
	thread: ThreadClock,
	now: number,
	policy: SlaPolicyView | null
): ClockPatch {
	const remaining = thread.responsePausedRemainingMs;
	if (remaining === undefined) return {};
	if (!policy) return { ...CLEARED };
	const due =
		remaining <= 0 ? now + remaining : (addBusinessMs(now, remaining, policy.calendar) ?? null);
	if (due === null) return { ...CLEARED };
	return { responseDueAt: due, responsePausedRemainingMs: undefined };
}

/** A thread status change. */
export function clockOnStatus(
	thread: ThreadClock,
	to: Doc<'conversationThreads'>['status'],
	now: number,
	policy: SlaPolicyView | null
): ClockPatch {
	if (to === 'resolved' || to === 'closed') return { ...stopClock(thread, now), resolvedAt: now };
	const reopened: ClockPatch = thread.resolvedAt !== undefined ? { resolvedAt: undefined } : {};
	if (to === 'waiting') return { ...reopened, ...pauseClock(thread, now, policy) };
	// Back to open: resume, unless a snooze still holds the clock.
	const snoozed = thread.snoozedUntil !== undefined && thread.snoozedUntil > now;
	return snoozed ? reopened : { ...reopened, ...resumeClock(thread, now, policy) };
}
