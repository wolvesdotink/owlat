/**
 * A Team Inbox conversation's priority, as the web app shows and sets it. The
 * stored field (`conversationThreads.priority`) is absent for `normal`, which is
 * what every thread is until someone says otherwise.
 */

export type TeamThreadPriority = 'low' | 'normal' | 'urgent';

/** Most pressing first: the order the "Priority ›" submenu lists them in. */
export const TEAM_THREAD_PRIORITIES: readonly TeamThreadPriority[] = ['urgent', 'normal', 'low'];

/** The catalog key for each priority's name. */
export const TEAM_THREAD_PRIORITY_KEYS: Readonly<Record<TeamThreadPriority, string>> = {
	urgent: 'dashboard.inbox.detail.priority.urgent',
	normal: 'dashboard.inbox.detail.priority.normal',
	low: 'dashboard.inbox.detail.priority.low',
};

/** The thread page's chip for a priority that is not normal (normal shows none). */
export const TEAM_THREAD_PRIORITY_CHIP_KEYS: Readonly<Record<'urgent' | 'low', string>> = {
	urgent: 'dashboard.inbox.detail.priorityChip.urgent',
	low: 'dashboard.inbox.detail.priorityChip.low',
};

/** A thread's priority, reading an absent or unknown value as normal. Pure. */
export function teamThreadPriorityOf(
	thread: { priority?: string | null } | null | undefined
): TeamThreadPriority {
	const value = thread?.priority;
	return value === 'urgent' || value === 'low' ? value : 'normal';
}
