/**
 * Team Inbox waiting time, as the thread row renders it.
 *
 * The rule itself lives on the server (apps/api/convex/inbox/threadSort.ts) —
 * `conversationThreads.lastMessageAt` is bumped ONLY by the inbound-activity
 * reducer, so it is "the newest message THEY sent", and a thread is waiting on
 * US when it is `open` and not currently snoozed. This module is the read-side
 * mirror: the same predicate over the projection the list returns, plus the
 * escalation tiers and the label the aging chip renders.
 *
 * Pure derivations with an injected `now`, so the tier boundaries and the
 * label are unit-testable without mounting the Convex-backed list.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The escalation the "Waiting > 24h" pill counts at.
 *
 * MIRRORS `WAITING_OVER_24H_MS` in apps/api/convex/inbox/threadSort.ts, which
 * is what the server-side pill count and its index range use. The two MUST
 * stay in lockstep — otherwise the pill counts three and only two rows paint
 * as overdue. Both sides pin the value in their own test.
 */
export const INBOX_WAITING_OVER_24H_MS = 24 * 60 * 60 * 1000;

/** First escalation: long enough that a person, not a queue, should look. */
export const INBOX_WAITING_ATTENTION_MS = 4 * HOUR;

/**
 * How urgent a wait is:
 *   - 'fresh'     → under the first escalation; a quiet, neutral chip.
 *   - 'attention' → past {@link INBOX_WAITING_ATTENTION_MS}.
 *   - 'overdue'   → past {@link INBOX_WAITING_OVER_24H_MS}; the pill's slice.
 */
export type InboxWaitingTier = 'fresh' | 'attention' | 'overdue';

/** The projection the derivation needs — a subset of the thread-list row. */
export interface InboxWaitingThread {
	status: 'open' | 'waiting' | 'resolved' | 'closed';
	lastMessageAt?: number | null;
	snoozedUntil?: number | null;
}

/**
 * Is this thread waiting on us? `open`, not snoozed, and carrying an inbound
 * timestamp at all — a row with no `lastMessageAt` has nothing to measure, so
 * it reports no wait rather than an age counted from the epoch.
 */
export function isWaitingOnUs(thread: InboxWaitingThread, now: number): boolean {
	if (thread.status !== 'open') return false;
	if (thread.lastMessageAt === undefined || thread.lastMessageAt === null) return false;
	return (
		thread.snoozedUntil === undefined || thread.snoozedUntil === null || thread.snoozedUntil <= now
	);
}

/**
 * How long the customer has waited, in ms — `null` when the thread is not
 * waiting on us, so the row cannot render an age for a resolved thread.
 * Clamped at zero: a clock skew must not render as a negative wait.
 */
export function inboxWaitingMs(thread: InboxWaitingThread, now: number): number | null {
	if (!isWaitingOnUs(thread, now)) return null;
	return Math.max(0, now - (thread.lastMessageAt as number));
}

/** Which escalation a wait has reached. Inclusive at each boundary. */
export function inboxWaitingTier(waitedMs: number): InboxWaitingTier {
	if (waitedMs >= INBOX_WAITING_OVER_24H_MS) return 'overdue';
	return waitedMs >= INBOX_WAITING_ATTENTION_MS ? 'attention' : 'fresh';
}

/**
 * Chip styling per tier. A module-scope registry, so these are class strings
 * and never sentences; the escalation is carried by colour AND by the label,
 * so colour is never the only signal.
 */
export const INBOX_WAITING_TIER_CLASS: Record<InboxWaitingTier, string> = {
	fresh: 'text-text-tertiary',
	attention: 'text-warning',
	overdue: 'text-error',
};

/** A localizable string: an i18n key plus the values it interpolates. */
export interface InboxWaitingLabel {
	key: string;
	params: Record<string, number>;
}

/**
 * The chip's sentence, as a key + params rather than assembled text.
 *
 * One message per SHAPE, not per fragment: which unit a language pluralises,
 * how it joins two of them and where the number sits are all part of the
 * sentence. Under an hour reads in minutes, under a day in hours, and past
 * that in days — with the hours only when they are non-zero, because "3d 0h"
 * is noise.
 */
export function inboxWaitingLabel(waitedMs: number): InboxWaitingLabel {
	const base = 'shared.inboxWaiting';
	if (waitedMs < HOUR) {
		return { key: `${base}.minutes`, params: { minutes: Math.floor(waitedMs / MINUTE) } };
	}
	if (waitedMs < DAY) {
		return { key: `${base}.hours`, params: { hours: Math.floor(waitedMs / HOUR) } };
	}
	const days = Math.floor(waitedMs / DAY);
	const hours = Math.floor((waitedMs % DAY) / HOUR);
	return hours === 0
		? { key: `${base}.days`, params: { days } }
		: { key: `${base}.daysHours`, params: { days, hours } };
}

/** What the row needs to paint the chip, or `null` when there is nothing to show. */
export interface InboxWaitingChip {
	tier: InboxWaitingTier;
	label: InboxWaitingLabel;
	waitedMs: number;
}

/** The whole derivation in one call, for the row. */
export function inboxWaitingChip(thread: InboxWaitingThread, now: number): InboxWaitingChip | null {
	const waitedMs = inboxWaitingMs(thread, now);
	if (waitedMs === null) return null;
	return { tier: inboxWaitingTier(waitedMs), label: inboxWaitingLabel(waitedMs), waitedMs };
}
