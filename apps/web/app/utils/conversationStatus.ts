/**
 * The status vocabulary for conversation rows — one pill per row, the most
 * urgent one wins. Mirrors `apps/api/convex/today/threadStatus.ts` (which
 * derives it for Postbox threads) and adds the states the web derives itself:
 * a team-inbox thread the agent is still working on, and a chat mention.
 *
 * Pure so the ordering is unit-testable; labels are i18n keys resolved at
 * render time.
 */

export type ConversationStatus =
	| 'draft_ready'
	| 'needs_you'
	| 'mentioned'
	| 'working'
	| 'updated'
	| 'waiting'
	| 'results_in'
	| 'running'
	| 'scheduled'
	| 'needs_review';

/** Lower index = more urgent. */
export const CONVERSATION_STATUS_PRIORITY: readonly ConversationStatus[] = [
	'draft_ready',
	'needs_you',
	'needs_review',
	'mentioned',
	'working',
	'updated',
	'results_in',
	'running',
	'scheduled',
	'waiting',
];

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
 * A team-inbox thread's status from what `inbox.queries.listThreads` returns.
 * The agent's draft waiting for approval outranks everything; a thread with
 * news the viewer has not seen reads as "Updated"; one we answered and are
 * waiting on reads as "Waiting on them".
 */
export function teamThreadStatus(thread: {
	latestDraftStatus?: string;
	unread?: boolean;
	status?: string;
}): ConversationStatus | null {
	if (thread.latestDraftStatus === 'pending') return 'draft_ready';
	if (thread.unread) return 'updated';
	if (thread.status === 'waiting') return 'waiting';
	return null;
}

/**
 * A Postbox thread's status from the thread document alone (list views that
 * read `mail.mailbox.queries.listThreads`). "Updated" needs the viewer's own
 * visit log, which only the sidebar/Today reads carry, so it is not derived
 * here.
 */
export function mailThreadStatus(thread: {
	needsReply?: { draftSlot?: unknown; clarification?: { draft?: unknown } | null } | null;
	followUp?: { dueAt?: number } | null;
}): ConversationStatus | null {
	const flag = thread.needsReply;
	if (flag && (flag.draftSlot || flag.clarification?.draft)) return 'draft_ready';
	if (flag || thread.followUp?.dueAt !== undefined) return 'needs_you';
	if (thread.followUp) return 'waiting';
	return null;
}
