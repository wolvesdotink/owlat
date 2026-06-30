/**
 * A message is "snoozed" — hidden from its folder and excluded from
 * folder.unseenCount — while snoozedUntil is in the future. Shared so the list
 * filter, the unread-counter math, and the wakeup cron all agree.
 */
export function isMessageSnoozed(
	m: { snoozedUntil?: number | null },
	now: number
): boolean {
	return m.snoozedUntil != null && m.snoozedUntil > now;
}
