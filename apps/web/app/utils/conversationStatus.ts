/**
 * The status vocabulary for conversation rows — one pill per row, the most
 * urgent one wins. Built on `@owlat/shared/threadStatus` (the rule the Convex
 * Today and sidebar reads derive Postbox thread status with) and widened with
 * the states the web derives itself: a team-inbox thread the agent is still
 * working on, a chat mention, and the automation/review states.
 *
 * Pure so the ordering is unit-testable; labels are i18n keys resolved at
 * render time.
 */
import {
	THREAD_STATUS_PRIORITY,
	type ThreadStatus,
	type ThreadStatusInput,
	deriveThreadStatus,
} from '@owlat/shared/threadStatus';

/** Pill states only the web derives (never computed by the Convex reads). */
type WebOnlyStatus =
	| 'mentioned'
	| 'working'
	| 'results_in'
	| 'running'
	| 'scheduled'
	| 'needs_review';

export type ConversationStatus = ThreadStatus | WebOnlyStatus;

/**
 * Where each web-only state ranks: listed right after the shared status it
 * follows. Keyed by every shared status, so a status added to the shared list
 * fails to compile here until its web neighbours are decided.
 */
const WEB_ONLY_AFTER: Record<ThreadStatus, readonly WebOnlyStatus[]> = {
	draft_ready: [],
	needs_you: ['needs_review', 'mentioned', 'working'],
	updated: ['results_in', 'running', 'scheduled'],
	waiting: [],
};

/**
 * Lower index = more urgent: the shared `THREAD_STATUS_PRIORITY` with the
 * web-only states inserted at their positions.
 */
export const CONVERSATION_STATUS_PRIORITY: readonly ConversationStatus[] =
	THREAD_STATUS_PRIORITY.flatMap((status) => [status, ...WEB_ONLY_AFTER[status]]);

export const CONVERSATION_STATUS_LABEL: Record<ConversationStatus, string> = {
	draft_ready: 'components.shell.status.draftReady',
	needs_you: 'components.shell.status.needsYou',
	needs_review: 'components.shell.status.needsReview',
	mentioned: 'components.shell.status.mentioned',
	working: 'components.shell.status.working',
	updated: 'components.shell.status.updated',
	results_in: 'components.shell.status.resultsIn',
	running: 'components.shell.status.running',
	scheduled: 'components.shell.status.scheduled',
	waiting: 'components.shell.status.waiting',
};

/** Text colour per status (the dot uses `currentColor`). */
export const CONVERSATION_STATUS_TONE: Record<ConversationStatus, string> = {
	draft_ready: 'text-warning',
	needs_you: 'text-brand',
	needs_review: 'text-brand',
	mentioned: 'text-brand',
	working: 'text-info',
	running: 'text-info',
	updated: 'text-success',
	results_in: 'text-success',
	scheduled: 'text-text-tertiary',
	waiting: 'text-text-tertiary',
};

/** States that are live processes — their dot pulses (motion-safe only). */
export const PULSING_STATUSES: ReadonlySet<ConversationStatus> = new Set(['working', 'running']);

/**
 * The most urgent status in a set — `mostUrgentStatus` from
 * `@owlat/shared/threadStatus`, ranked over the wider web union.
 */
export function mostUrgentConversationStatus(
	statuses: ReadonlyArray<ConversationStatus | null | undefined>
): ConversationStatus | null {
	let best: ConversationStatus | null = null;
	for (const status of statuses) {
		if (!status) continue;
		if (
			best === null ||
			CONVERSATION_STATUS_PRIORITY.indexOf(status) < CONVERSATION_STATUS_PRIORITY.indexOf(best)
		) {
			best = status;
		}
	}
	return best;
}

/**
 * A team-inbox thread's sidebar pill from what `inbox.queries.listThreads`
 * returns. The agent's draft waiting for approval outranks everything; a
 * thread with news the viewer has not seen reads as "Updated"; one we answered
 * and are waiting on reads as "Waiting on them".
 *
 * This is deliberately NOT `threadStatusChip` (`utils/threadStatusChip.ts`).
 * The chip names a thread's lifecycle and always renders one word (Resolved,
 * Snoozed, Draft ready, Waiting on them, Open) on the thread page and team
 * inbox list. This pill says "look here" in the shared sidebar and Inboxes
 * vocabulary with Postbox rows, so a quiet open thread gets no pill at all and
 * unread news ("Updated") ranks above waiting. The two share the chip's
 * precedence for the states that end the need to look: a resolved (or legacy
 * closed) thread and an actively snoozed one get no pill, exactly where the
 * chip would say Resolved or Snoozed, so the pill can never claim a draft or
 * news on a thread the chip shows as done or asleep.
 */
export function teamThreadStatus(thread: {
	latestDraftStatus?: string;
	unread?: boolean;
	status?: string;
	snoozedUntil?: number | null;
	/** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
	now?: number;
}): ConversationStatus | null {
	if (thread.status === 'resolved' || thread.status === 'closed') return null;
	if (thread.snoozedUntil != null && thread.snoozedUntil > (thread.now ?? Date.now())) {
		return null;
	}
	if (thread.latestDraftStatus === 'pending') return 'draft_ready';
	if (thread.unread) return 'updated';
	if (thread.status === 'waiting') return 'waiting';
	return null;
}

/**
 * A Postbox thread's status from the thread document alone (list views that
 * read `mail.mailbox.queries.listThreads`): the shared `deriveThreadStatus`
 * with no unseen messages. "Updated" needs the viewer's own visit log, which
 * only the sidebar/Today reads carry, so it is never derived here.
 */
export function mailThreadStatus(
	thread: Omit<ThreadStatusInput, 'newSinceVisit'>
): ConversationStatus | null {
	return deriveThreadStatus({ ...thread, newSinceVisit: 0 });
}
