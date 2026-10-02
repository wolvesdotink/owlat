/**
 * Pure planning for "assigned to you" notifications.
 *
 * The assignee's session subscribes to `inbox.queries.pendingAssignments` and
 * feeds each update through `planAssignmentNotices`, which:
 *   - drops notices the client has already surfaced (`seen` ids), so a
 *     re-delivered query window never re-toasts;
 *   - coalesces a burst — notices whose timestamps fall within one window of
 *     each other collapse into a single "N conversations assigned to you"
 *     notice instead of a stack, so a bulk reassignment is one ping, not ten.
 *
 * Kept free of Vue / Convex so the coalescing window is unit-testable in
 * isolation (mirrors lib/desktop/notificationRules.ts).
 */

export type AssignmentNoticeKind = 'assignment' | 'clarification' | 'mention' | 'sla_breach';

export interface AssignmentNotice {
	/** Notice row id — the de-dup key. */
	id: string;
	/**
	 * `assignment` (a teammate handed over a thread; the default) or
	 * `clarification` (the agent parked a reply because it needs a fact from
	 * this person). Clarifications are never coalesced: each one is a question
	 * someone is waiting on, so each one gets its own line. `mention` (a
	 * teammate @-mentioned this person in an internal note) is not coalesced
	 * either, for the same reason, and it opens on the note (`noteId`).
	 * `sla_breach` is a reply target passing unanswered (`assignedByName` is
	 * then the customer); breaches coalesce among themselves, apart from
	 * assignments.
	 */
	kind?: AssignmentNoticeKind;
	threadId: string;
	/** The note that mentioned the person (`mention` notices only). */
	noteId?: string | null;
	subject: string;
	assignedByName: string;
	createdAt: number;
}

export type AssignmentNoticePlan =
	| { kind: 'single'; notice: AssignmentNotice }
	| { kind: 'group'; count: number; sample: AssignmentNotice };

/** Bursts within this window collapse into one grouped notice. */
export const ASSIGNMENT_COALESCE_WINDOW_MS = 60_000;

/**
 * Plan the toasts/notifications for a fresh query window.
 *
 * @param notices  the current query window (any order)
 * @param seen     ids already surfaced this session (not mutated)
 * @param windowMs coalescing window; defaults to one minute
 */
export function planAssignmentNotices(
	notices: AssignmentNotice[],
	seen: ReadonlySet<string>,
	windowMs: number = ASSIGNMENT_COALESCE_WINDOW_MS
): AssignmentNoticePlan[] {
	const unseen = notices.filter((n) => !seen.has(n.id));
	const breaches = unseen.filter((n) => n.kind === 'sla_breach');
	const others = unseen.filter((n) => n.kind !== 'sla_breach');
	// A sweep flags overdue threads in one burst: one line for the burst, not
	// one per thread, and never folded into an assignment group.
	return [...planRuns(others, windowMs), ...planRuns(breaches, windowMs)];
}

function planRuns(notices: AssignmentNotice[], windowMs: number): AssignmentNoticePlan[] {
	const fresh = [...notices].sort((a, b) => a.createdAt - b.createdAt);

	const plans: AssignmentNoticePlan[] = [];
	let run: AssignmentNotice[] = [];

	const flush = () => {
		if (run.length === 0) return;
		if (run.length === 1) {
			const only = run[0];
			if (only) plans.push({ kind: 'single', notice: only });
		} else {
			const sample = run[run.length - 1];
			if (sample) plans.push({ kind: 'group', count: run.length, sample });
		}
		run = [];
	};

	for (const n of fresh) {
		if (n.kind === 'clarification' || n.kind === 'mention') {
			flush();
			plans.push({ kind: 'single', notice: n });
			continue;
		}
		const prev = run[run.length - 1];
		if (prev && n.createdAt - prev.createdAt > windowMs) flush();
		run.push(n);
	}
	flush();

	return plans;
}

/**
 * A line the caller translates. This module is module scope and never calls
 * `useI18n`, so its copy travels as an i18n key plus the parameters that key
 * interpolates (see the UI-localization guide).
 */
export type AssignmentMessage = { key: string; params?: Record<string, unknown> };

/** The interpolation params a single-notice message needs. */
function noticeParams(notice: AssignmentNotice): Record<string, unknown> {
	return {
		subject: notice.subject,
		assignedByName: notice.assignedByName,
	};
}

/**
 * The message key for one assignment — a separate key when the mail carries no
 * subject at all, so the missing-subject wording is translated rather than
 * spliced into the sentence.
 */
function noticeKey(notice: AssignmentNotice, base: string): string {
	return notice.subject ? `${base}.withSubject` : `${base}.noSubject`;
}

/**
 * Where a single notice opens: the thread, scrolled to the note for a mention.
 */
export function assignmentNoticeHref(notice: AssignmentNotice): string {
	const thread = `/dashboard/inbox/${notice.threadId}`;
	return notice.kind === 'mention' && notice.noteId ? `${thread}#note-${notice.noteId}` : thread;
}

/** In-app toast copy for a single assignment (or a clarification ask, a mention or a breach). */
export function assignmentToastMessage(notice: AssignmentNotice): AssignmentMessage {
	if (notice.kind === 'mention') {
		return {
			key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.mention.toast'),
			params: noticeParams(notice),
		};
	}
	if (notice.kind === 'sla_breach') {
		return {
			key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.slaBreach.toast'),
			params: noticeParams(notice),
		};
	}
	if (notice.kind === 'clarification') {
		return {
			key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.clarification.toast'),
			params: noticeParams(notice),
		};
	}
	return {
		key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.toast.single'),
		params: noticeParams(notice),
	};
}

/** In-app toast copy for a coalesced burst (of assignments, or of breaches). */
export function assignmentGroupToastMessage(
	count: number,
	kind?: AssignmentNoticeKind
): AssignmentMessage {
	if (kind === 'sla_breach') {
		return { key: 'shared.inbox.assignmentNoticeRules.slaBreach.group', params: { count } };
	}
	return { key: 'shared.inbox.assignmentNoticeRules.toast.group', params: { count } };
}

/** Desktop notification title + body for a single assignment (or a clarification ask, a mention or a breach). */
export function assignmentNotificationParts(notice: AssignmentNotice): {
	title: AssignmentMessage;
	body: AssignmentMessage;
} {
	if (notice.kind === 'mention') {
		return {
			title: { key: 'shared.inbox.assignmentNoticeRules.mention.notificationTitle' },
			body: {
				key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.mention.notificationBody'),
				params: noticeParams(notice),
			},
		};
	}
	if (notice.kind === 'sla_breach') {
		return {
			title: { key: 'shared.inbox.assignmentNoticeRules.slaBreach.notificationTitle' },
			body: {
				key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.slaBreach.notificationBody'),
				params: noticeParams(notice),
			},
		};
	}
	if (notice.kind === 'clarification') {
		return {
			title: { key: 'shared.inbox.assignmentNoticeRules.clarification.notificationTitle' },
			body: {
				key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.clarification.notificationBody'),
				params: noticeParams(notice),
			},
		};
	}
	return {
		title: { key: 'shared.inbox.assignmentNoticeRules.notification.singleTitle' },
		body: {
			key: noticeKey(notice, 'shared.inbox.assignmentNoticeRules.notification.body'),
			params: noticeParams(notice),
		},
	};
}

/** Desktop notification title + body for a coalesced burst. */
export function assignmentGroupNotificationParts(
	count: number,
	kind?: AssignmentNoticeKind
): {
	title: AssignmentMessage;
	body: AssignmentMessage;
} {
	return {
		title: {
			key:
				kind === 'sla_breach'
					? 'shared.inbox.assignmentNoticeRules.slaBreach.notificationTitle'
					: 'shared.inbox.assignmentNoticeRules.notification.groupTitle',
		},
		body: assignmentGroupToastMessage(count, kind),
	};
}
