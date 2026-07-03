/**
 * Conversation thread (module) — single writer of `conversationThreads`.
 *
 * Owns find-or-create (email + non-email channel intake), the denormalized
 * counter maintenance (`messageCount` / `lastMessageAt`), the inbound reopen
 * policy, the `status` / `assignedTo` machine, and the `latestDraftStatus`
 * projection the Inbox processing lifecycle drives. Lifting every write to
 * the table behind one reducer closes the channel/email reopen split, the
 * `messageCount` increment race, and the audit gap on human thread actions
 * (ADR-0032 §1–§5).
 *
 * Shape mirrors the Mail draft lifecycle module (ADR-0028): a typed
 * `TransitionInput`, a per-kind pure reducer returning `{ patch, effects,
 * applied }`, and an effect runner that is the only place touching the DB.
 * Two differences from that module:
 *   - The discriminator is `kind`, not `to` — a thread has heterogeneous
 *     independent dimensions, so there is no single target state.
 *   - There is no LEGAL_EDGES graph — manual status changes are fully
 *     flexible (any literal → any literal); inbound-driven reopen is its
 *     own kind, not a status-machine edge.
 *
 * Unlike the Mail draft module these are plain `MutationCtx` helpers, not
 * `internalMutation`s: every caller (email/channel intake, assign/status
 * mutations, the lifecycle effect runner) already runs in a mutation, so a
 * direct call keeps the write atomic with the caller's own writes without a
 * cross-runtime `ctx.runMutation` hop.
 *
 * See docs/adr/0032-conversation-thread-module.md.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { recordAuditLog } from '../../lib/auditLog';
import { applyOpenThreadDelta } from '../../lib/inboxStats';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConversationThreadStatus = 'open' | 'waiting' | 'resolved' | 'closed';

export type ThreadDraftStatus = 'pending' | 'approved' | 'rejected' | 'sent';

/** Who drove the write — coarse actor category for the audit trail. */
export type ThreadWriteSource = 'inbound' | 'agent' | 'user';

export type TransitionInput =
	| { kind: 'inbound_activity'; occurredAt: number }
	| { kind: 'status_change'; to: ConversationThreadStatus; source: ThreadWriteSource }
	| { kind: 'assignment_change'; assignedTo?: string; source: ThreadWriteSource }
	| { kind: 'draft_status_change'; latestDraftStatus: ThreadDraftStatus };

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
		| 'thread.assigned'
		| 'thread.unassigned'
		| 'thread.draft_status_changed';
	threadId: Id<'conversationThreads'>;
	details: Record<string, string | number | boolean>;
};

type Effect = AuditLogEffect;

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
): ReducerResult {
	// Reopen any non-open thread on inbound activity. This preserves the email
	// path's original unconditional `status: 'open'` reopen (resolved/closed/
	// waiting → open) and extends the same policy to channels, which used to
	// fork instead (ADR-0032 §1). The reopen audit fires only on an actual
	// reopen edge — never on inbound to an already-open thread — to avoid
	// timeline noise.
	const reopened = thread.status !== 'open';
	return {
		patch: {
			messageCount: thread.messageCount + 1,
			lastMessageAt: occurredAt,
			...(reopened ? { status: 'open' as const } : {}),
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
	input: Extract<TransitionInput, { kind: 'status_change' }>,
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
	input: Extract<TransitionInput, { kind: 'assignment_change' }>,
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
	input: Extract<TransitionInput, { kind: 'draft_status_change' }>,
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

function reduce(
	thread: Doc<'conversationThreads'>,
	input: TransitionInput,
): ReducerResult {
	switch (input.kind) {
		case 'inbound_activity':
			return reduceInboundActivity(thread, input.occurredAt);
		case 'status_change':
			return reduceStatusChange(thread, input);
		case 'assignment_change':
			return reduceAssignmentChange(thread, input);
		case 'draft_status_change':
			return reduceDraftStatusChange(thread, input);
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: 'system',
					action: effect.action,
					resource: 'conversation_thread',
					resourceId: effect.threadId,
					details: effect.details,
				});
				break;
			}
		}
	}
}

async function applyTransition(
	ctx: MutationCtx,
	thread: Doc<'conversationThreads'>,
	input: TransitionInput,
): Promise<TransitionOutcome> {
	const result = reduce(thread, input);
	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(thread._id, result.patch);
		// Keep the denormalized open-thread counter exact. A reducer only ever
		// includes `status` in its patch when it actually changes (the no-op
		// guards return NOOP first), so a `status` key here is always a real
		// edge. Bump only when the edge crosses the open ↔ non-open boundary.
		if (result.patch.status !== undefined && result.patch.status !== thread.status) {
			const wasOpen = thread.status === 'open';
			const isOpen = result.patch.status === 'open';
			if (!wasOpen && isOpen) await applyOpenThreadDelta(ctx, 1);
			else if (wasOpen && !isOpen) await applyOpenThreadDelta(ctx, -1);
		}
	}
	await applyEffects(ctx, result.effects);
	return { ok: true, applied: result.applied, threadId: thread._id };
}

// ─── Intake entries (find-or-create + implicit inbound_activity) ────────────
//
// Both resolvers, on a hit OR a fresh create, immediately run the
// `inbound_activity` reducer so the count / lastMessageAt patch and the
// reopen-if-closed are atomic with discovery — the caller makes one call.

export async function findOrCreateForEmail(
	ctx: MutationCtx,
	args: {
		contactId?: Id<'contacts'>;
		contactIdentifier: string;
		subject: string;
		normalizedSubject: string;
		inReplyTo?: string;
		references?: string;
		occurredAt: number;
	},
): Promise<{ threadId: Id<'conversationThreads'>; action: 'matched' | 'created' }> {
	let threadId: Id<'conversationThreads'> | undefined;

	// RFC 5322 threading headers (Message-ID / In-Reply-To / References) are
	// attacker-controlled: a sender can forge an In-Reply-To pointing at another
	// contact's message to splice their inbound into that contact's thread, which
	// would then feed the other contact's history into the agent draft. So a
	// header match is only honoured when the referenced thread belongs to the
	// SAME contact identifier as the incoming sender; otherwise we ignore it and
	// fall through to the subject+contact composite (Strategy 3) / new thread.
	const ownedBySender = async (candidateThreadId: Id<'conversationThreads'>): Promise<boolean> => {
		const thread = await ctx.db.get(candidateThreadId);
		return thread?.contactIdentifier === args.contactIdentifier;
	};

	// Strategy 1 — In-Reply-To header → the referenced message's thread.
	if (args.inReplyTo) {
		const referenced = await ctx.db
			.query('inboundMessages')
			.withIndex('by_message_id', (q) => q.eq('messageId', args.inReplyTo!))
			.first();
		if (referenced?.threadId && (await ownedBySender(referenced.threadId))) {
			threadId = referenced.threadId;
		}
	}

	// Strategy 2 — References header (walk each id until one resolves).
	if (!threadId && args.references) {
		const refs = args.references.split(/\s+/).filter(Boolean);
		for (const ref of refs) {
			const referenced = await ctx.db
				.query('inboundMessages')
				.withIndex('by_message_id', (q) => q.eq('messageId', ref))
				.first();
			if (referenced?.threadId && (await ownedBySender(referenced.threadId))) {
				threadId = referenced.threadId;
				break;
			}
		}
	}

	// Strategy 3 — normalized subject + contact identifier composite.
	if (!threadId) {
		const existing = await ctx.db
			.query('conversationThreads')
			.withIndex('by_normalized_subject_and_contact', (q) =>
				q
					.eq('normalizedSubject', args.normalizedSubject)
					.eq('contactIdentifier', args.contactIdentifier),
			)
			.first();
		if (existing) threadId = existing._id;
	}

	const action: 'matched' | 'created' = threadId ? 'matched' : 'created';
	const resolvedId =
		threadId ??
		(await ctx.db.insert('conversationThreads', {
			subject: args.subject,
			normalizedSubject: args.normalizedSubject,
			contactId: args.contactId,
			contactIdentifier: args.contactIdentifier,
			status: 'open',
			messageCount: 0,
			lastMessageAt: args.occurredAt,
			firstMessageAt: args.occurredAt,
			createdAt: args.occurredAt,
		}));
	// A fresh thread is born 'open'; the subsequent inbound_activity won't
	// re-bump (already open), so account the open-count entry here.
	if (action === 'created') await applyOpenThreadDelta(ctx, 1);

	await runInboundActivity(ctx, resolvedId, args.occurredAt);
	return { threadId: resolvedId, action };
}

export async function findOrCreateForChannel(
	ctx: MutationCtx,
	args: {
		contactId?: Id<'contacts'>;
		contactIdentifier: string;
		subject: string;
		normalizedSubject: string;
		occurredAt: number;
	},
): Promise<{ threadId: Id<'conversationThreads'>; action: 'matched' | 'created' }> {
	// Single strategy — the contact's most-recent thread, STATUS-AGNOSTIC.
	// The matcher no longer skips closed threads (the §1 behaviour change):
	// a closed most-recent thread is matched and reopened by the shared
	// `inbound_activity` reducer rather than forked into a new thread.
	const existing = args.contactId
		? await ctx.db
				.query('conversationThreads')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.order('desc')
				.first()
		: null;

	const action: 'matched' | 'created' = existing ? 'matched' : 'created';
	const resolvedId =
		existing?._id ??
		(await ctx.db.insert('conversationThreads', {
			subject: args.subject,
			normalizedSubject: args.normalizedSubject,
			contactId: args.contactId,
			contactIdentifier: args.contactIdentifier,
			status: 'open',
			messageCount: 0,
			lastMessageAt: args.occurredAt,
			firstMessageAt: args.occurredAt,
			createdAt: args.occurredAt,
		}));
	// A fresh thread is born 'open'; the subsequent inbound_activity won't
	// re-bump (already open), so account the open-count entry here.
	if (action === 'created') await applyOpenThreadDelta(ctx, 1);

	await runInboundActivity(ctx, resolvedId, args.occurredAt);
	return { threadId: resolvedId, action };
}

/**
 * Re-read the just-resolved/created row and run the `inbound_activity`
 * reducer against it. The read→reduce→patch sequence has no intervening IO,
 * so the counter increment cannot race (§2).
 */
async function runInboundActivity(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	occurredAt: number,
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	await applyTransition(ctx, thread, { kind: 'inbound_activity', occurredAt });
	await cancelStalePendingAutoSends(ctx, threadId);
}

/**
 * A new inbound landing in an existing thread makes any queued AUTONOMOUS
 * auto-reply stale — the customer said more before the delayed send fired. For
 * each prior `approved` message in this thread still holding a cancellable
 * `pendingAutoSend` marker, schedule its cancellation (which aborts the delayed
 * send and routes the draft back to human review). Best-effort and fail-soft:
 * the cancel runs in its own scheduled mutation so a miss never blocks intake,
 * and a thread with nothing pending is a cheap empty scan.
 */
async function cancelStalePendingAutoSends(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
): Promise<void> {
	// Bounded scan on the intake hot path: a thread realistically holds at most
	// one `approved`+pending message, and the cancel is best-effort, so cap the
	// read rather than `.collect()` an arbitrarily long thread on every inbound.
	const messages = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.take(200);
	for (const message of messages) {
		if (message.processingStatus === 'approved' && message.pendingAutoSend) {
			await ctx.scheduler.runAfter(
				0,
				internal.inbox.processingLifecycle.cancelAutoSend,
				{ inboundMessageId: message._id, reason: 'thread_reply' },
			);
		}
	}
}

// ─── Direct transition entry (non-intake writes) ────────────────────────────

/**
 * Apply a non-intake transition to an existing thread by id. Sole writer of
 * `status`, `assignedTo`, and `latestDraftStatus`. Missing threads are
 * reported via `{ ok: false, reason: 'thread_not_found' }` — never thrown.
 */
export async function transition(
	ctx: MutationCtx,
	args: { threadId: Id<'conversationThreads'>; input: TransitionInput },
): Promise<TransitionOutcome> {
	const thread = await ctx.db.get(args.threadId);
	if (!thread) return { ok: false, reason: 'thread_not_found' };
	return applyTransition(ctx, thread, args.input);
}
