/**
 * Conversation thread reducers: the transition inputs and the pure per-kind
 * reducers `./module.ts` runs. Kept apart from the module so neither crosses
 * the file-size cap; the module stays the only caller and the only writer of
 * the table.
 */

import type { Doc, Id } from '../../_generated/dataModel';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConversationThreadStatus = 'open' | 'waiting' | 'resolved' | 'closed';

type ThreadDraftStatus = 'pending' | 'approved' | 'rejected' | 'sent';

/** Who drove the write — coarse actor category for the audit trail. */
export type ThreadWriteSource = 'inbound' | 'agent' | 'user';

export type TransitionInput =
	| { kind: 'inbound_activity'; occurredAt: number; preview?: string }
	| { kind: 'status_change'; to: ConversationThreadStatus; source: ThreadWriteSource }
	| { kind: 'assignment_change'; assignedTo?: string; source: ThreadWriteSource }
	| { kind: 'draft_status_change'; latestDraftStatus: ThreadDraftStatus }
	// A reply reached the customer: closes the response clock (inbox/sla/clock.ts).
	| { kind: 'reply_sent'; at: number }
	// The auto-close sweep found a waiting thread quiet for `quietDays` since
	// `quietSince` (inbox/autoClose.ts decided it was due).
	| { kind: 'auto_close'; at: number; quietDays: number; quietSince: number };

export type TransitionOutcome =
	| { ok: true; applied: 'transitioned' | 'noop'; threadId: Id<'conversationThreads'> }
	| { ok: false; reason: 'thread_not_found' };

// ─── Effects ──────────────────────────────────────────────────────────────────
//
// One effect kind: `audit_log`. The reducers are pure and never touch the DB;
// the runner is the sole writer of `auditLogs` rows for this table.

type AuditLogEffect = {
	kind: 'audit_log';
	action:
		| 'thread.reopened_by_inbound'
		| 'thread.status_changed'
		| 'thread.auto_closed'
		| 'thread.assigned'
		| 'thread.unassigned'
		| 'thread.draft_status_changed';
	threadId: Id<'conversationThreads'>;
	details: Record<string, string | number | boolean>;
};

export type Effect = AuditLogEffect;

type ReducerResult = {
	patch: Partial<Doc<'conversationThreads'>>;
	effects: Effect[];
	applied: 'transitioned' | 'noop';
};

const NOOP: ReducerResult = { patch: {}, effects: [], applied: 'noop' };

// ─── Reducers ───────────────────────────────────────────────────────────────
//
// Each reducer reads the thread and the input and returns the patch + effect
// list. No intervening IO between the count read and the count patch — this
// is what closes the §2 `messageCount` race.

function reduceInboundActivity(
	thread: Doc<'conversationThreads'>,
	occurredAt: number,
	preview?: string
): ReducerResult {
	// Reopen any non-open thread on inbound activity. This preserves the email
	// path's original unconditional `status: 'open'` reopen (resolved/closed/
	// waiting → open) and extends the same policy to channels, which used to
	// fork instead. The reopen audit fires only on an actual
	// reopen edge — never on inbound to an already-open thread — to avoid
	// timeline noise.
	const reopened = thread.status !== 'open';
	// An inbound reply on a snoozed thread resurfaces it immediately: clear the
	// snooze and stamp `snoozeReturnedAt` so the row shows the same "returned"
	// marker the wake cron uses. `snoozedUntil` is only ever a future value, so a
	// simple presence check is the snoozed signal.
	const wasSnoozed = thread.snoozedUntil !== undefined;
	return {
		patch: {
			messageCount: thread.messageCount + 1,
			lastMessageAt: occurredAt,
			// Denormalize the newest message's preview for the team-inbox row.
			// Only overwrite when the caller supplied one — an activity with no
			// extractable preview keeps the prior snippet rather than blanking it.
			...(preview ? { lastPreview: preview } : {}),
			...(reopened ? { status: 'open' as const } : {}),
			...(wasSnoozed ? { snoozedUntil: undefined, snoozeReturnedAt: occurredAt } : {}),
		},
		effects: reopened
			? [
					{
						kind: 'audit_log',
						action: 'thread.reopened_by_inbound',
						threadId: thread._id,
						details: { previousStatus: thread.status },
					},
				]
			: [],
		applied: 'transitioned',
	};
}

function reduceStatusChange(
	thread: Doc<'conversationThreads'>,
	input: Extract<TransitionInput, { kind: 'status_change' }>
): ReducerResult {
	if (thread.status === input.to) return NOOP;
	return {
		patch: { status: input.to },
		effects: [
			{
				kind: 'audit_log',
				action: 'thread.status_changed',
				threadId: thread._id,
				details: { from: thread.status, to: input.to, source: input.source },
			},
		],
		applied: 'transitioned',
	};
}

function reduceAssignmentChange(
	thread: Doc<'conversationThreads'>,
	input: Extract<TransitionInput, { kind: 'assignment_change' }>
): ReducerResult {
	// Treat absent + absent (and same-user + same-user) as a no-op so a
	// redundant re-assign doesn't spam the audit trail.
	if ((thread.assignedTo ?? undefined) === (input.assignedTo ?? undefined)) {
		return NOOP;
	}
	const assigning = input.assignedTo !== undefined;
	return {
		patch: { assignedTo: input.assignedTo },
		effects: [
			{
				kind: 'audit_log',
				action: assigning ? 'thread.assigned' : 'thread.unassigned',
				threadId: thread._id,
				details: assigning
					? { userId: input.assignedTo as string, source: input.source }
					: { source: input.source },
			},
		],
		applied: 'transitioned',
	};
}

function reduceDraftStatusChange(
	thread: Doc<'conversationThreads'>,
	input: Extract<TransitionInput, { kind: 'draft_status_change' }>
): ReducerResult {
	if (thread.latestDraftStatus === input.latestDraftStatus) return NOOP;
	return {
		patch: { latestDraftStatus: input.latestDraftStatus },
		effects: [
			{
				kind: 'audit_log',
				action: 'thread.draft_status_changed',
				threadId: thread._id,
				details: { latestDraftStatus: input.latestDraftStatus },
			},
		],
		applied: 'transitioned',
	};
}

function reduceAutoClose(
	thread: Doc<'conversationThreads'>,
	input: Extract<TransitionInput, { kind: 'auto_close' }>
): ReducerResult {
	// Re-checked here, in the closing write: a reply, a status change or an
	// opt-out since the sweep read the thread leaves it alone.
	if (thread.status !== 'waiting' || thread.isAutoCloseDisabled) return NOOP;
	return {
		patch: {
			status: 'resolved',
			autoClosedAt: input.at,
			autoClosedQuietDays: input.quietDays,
			waitingSince: undefined,
		},
		effects: [
			{
				kind: 'audit_log',
				action: 'thread.auto_closed',
				threadId: thread._id,
				details: { quietDays: input.quietDays, quietSince: input.quietSince },
			},
		],
		applied: 'transitioned',
	};
}

export function reduce(thread: Doc<'conversationThreads'>, input: TransitionInput): ReducerResult {
	switch (input.kind) {
		case 'inbound_activity':
			return reduceInboundActivity(thread, input.occurredAt, input.preview);
		case 'status_change':
			return reduceStatusChange(thread, input);
		case 'assignment_change':
			return reduceAssignmentChange(thread, input);
		case 'draft_status_change':
			return reduceDraftStatusChange(thread, input);
		case 'reply_sent':
			// Nothing of its own: the response clock below is the whole effect.
			return { patch: {}, effects: [], applied: 'transitioned' };
		case 'auto_close':
			return reduceAutoClose(thread, input);
	}
}
