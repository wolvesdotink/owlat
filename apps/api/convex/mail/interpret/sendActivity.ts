/**
 * Activity of the replies we send (SPEC §5 "Outbound" and "Activity
 * writers"), appended in the transaction of the send event it records. Each
 * hook is called from the module that owns the event, and keeps the host file
 * small:
 *
 *   Postbox
 *   - {@link recordPostboxSendQueued} / {@link recordPostboxSendCancelled}:
 *     a reply in a thread was handed to the undo window or a schedule, or
 *     pulled back (`mail/draftSend.ts`).
 *   - {@link onPostboxRecipientTransition}: the transport lifecycle
 *     (`mail/postboxOutboundLifecycle.ts`). The first recipient that reached
 *     `sent` appends `reply_sent` and enqueues the interpretation of the sent
 *     message, once; a recipient that bounced or failed appends
 *     `delivery_failed` and fails what that send answered for them
 *     (`sendFailure.ts`).
 *
 *   Team Inbox (agent replies to an inbound message)
 *   - {@link recordTeamSendQueued}: an approval scheduled the send
 *     (`inbox/processingLifecycle/effects.ts`).
 *   - {@link recordTeamSendCancelled} / {@link recordTeamSendHeld}: the undo
 *     window pulled it back, or it waits for a file copy
 *     (`inbox/processingLifecycle/autoSendCancel.ts`).
 *   - {@link onTeamSendFinalized}: the Send reached a terminal edge
 *     (`delivery/sendLifecycle/sourceFinalization.ts`), NOT `sendApprovedReply`,
 *     which only queues. `sent` appends `auto_sent` (router auto-approve) or
 *     `reply_sent` and enqueues the reply's interpretation; `failed` / `bounced`
 *     appends `delivery_failed` and fails what the reply answered.
 *
 * Idempotency keys name the event and the send: a repeat (a webhook redelivery,
 * a second recipient reaching `sent`) is a no-op.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { appendActivity } from './activity';
import { enqueueSentInterpretation } from './enqueue';
import { reconcileSendFailure } from './sendFailure';

function userActor(userId: string | undefined) {
	return { kind: 'user' as const, ...(userId ? { id: userId } : {}) };
}

// ── Postbox ────────────────────────────────────────────────────────────────

/** A reply draft was sent into its undo window, or scheduled. */
export async function recordPostboxSendQueued(
	ctx: MutationCtx,
	draft: Pick<Doc<'mailDrafts'>, '_id' | 'threadId'>,
	args: { userId: string; undoToken?: string; sendAt?: number; isScheduled: boolean }
): Promise<void> {
	if (!draft.threadId) return;
	await appendActivity(ctx, {
		threadRef: { kind: 'mail', id: draft.threadId },
		idempotencyKey: `send_queued:${draft._id}:${args.undoToken ?? args.sendAt ?? 'now'}`,
		type: 'send_queued',
		actor: userActor(args.userId),
		provenance: 'recorded',
		payload: {
			...(args.sendAt !== undefined ? { sendAt: args.sendAt } : {}),
			isScheduled: args.isScheduled,
		},
	});
}

/** The undo window or a scheduled send was cancelled: the reply is a draft again. */
export async function recordPostboxSendCancelled(
	ctx: MutationCtx,
	draft: Pick<Doc<'mailDrafts'>, '_id' | 'threadId'>,
	args: { userId: string; at: number }
): Promise<void> {
	if (!draft.threadId) return;
	await appendActivity(ctx, {
		threadRef: { kind: 'mail', id: draft.threadId },
		idempotencyKey: `send_cancelled:${draft._id}:${args.at}`,
		type: 'send_cancelled',
		actor: userActor(args.userId),
		provenance: 'recorded',
	});
}

/**
 * One recipient of a Postbox outbound message changed state (called after the
 * lifecycle patched the row, so failure reads see the new state).
 */
export async function onPostboxRecipientTransition(
	ctx: MutationCtx,
	args: {
		message: Pick<Doc<'mailMessages'>, '_id' | 'threadId' | 'sentByUserId'>;
		recipient: { idx: number; address: string };
		to: 'queued' | 'sent' | 'bounced' | 'failed';
		at: number;
	}
): Promise<void> {
	const { message } = args;
	const threadRef: ThreadRef = { kind: 'mail', id: message.threadId };
	const opRef = { kind: 'outbound' as const, id: message._id };
	if (args.to === 'sent') {
		const appended = await appendActivity(ctx, {
			threadRef,
			idempotencyKey: `sent:${message._id}`,
			type: 'reply_sent',
			actor: userActor(message.sentByUserId),
			provenance: 'recorded',
			opRef,
			eventAt: args.at,
		});
		if (appended && !appended.isDuplicate) {
			await enqueueSentInterpretation(ctx, { kind: 'outboundMail', id: message._id }, threadRef);
		}
		return;
	}
	if (args.to !== 'bounced' && args.to !== 'failed') return;
	await appendActivity(ctx, {
		threadRef,
		idempotencyKey: `delivery_failed:${message._id}:${args.recipient.idx}`,
		type: 'delivery_failed',
		actor: { kind: 'system' },
		provenance: 'recorded',
		opRef,
		eventAt: args.at,
		payload: { recipient: args.recipient.address, state: args.to },
	});
	await reconcileSendFailure(ctx, { kind: 'outboundMail', id: message._id });
}

// ── Team Inbox ─────────────────────────────────────────────────────────────

/** The team thread an agent reply answers, or null when it has none. */
async function teamThreadOf(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<{ inbound: Doc<'inboundMessages'>; threadRef: ThreadRef } | null> {
	const inbound = await ctx.db.get(inboundMessageId);
	if (!inbound?.threadId) return null;
	return { inbound, threadRef: { kind: 'team', id: inbound.threadId } };
}

/** An approval scheduled the reply's send (after its undo window, if any). */
export async function recordTeamSendQueued(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	args: { isAutonomous: boolean; sendAt: number }
): Promise<void> {
	const team = await teamThreadOf(ctx, inboundMessageId);
	if (!team) return;
	await appendActivity(ctx, {
		threadRef: team.threadRef,
		idempotencyKey: `send_queued:${inboundMessageId}:${args.sendAt}`,
		type: 'send_queued',
		actor: args.isAutonomous ? { kind: 'agent' } : { kind: 'user' },
		provenance: 'recorded',
		payload: { sendAt: args.sendAt },
	});
}

/** A queued reply was pulled back to review (Undo, a landing reply, the kill switch). */
export async function recordTeamSendCancelled(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	args: { reason: string; userId?: string; scheduledAt: number }
): Promise<void> {
	if (!message.threadId) return;
	await appendActivity(ctx, {
		threadRef: { kind: 'team', id: message.threadId },
		idempotencyKey: `send_cancelled:${message._id}:${args.scheduledAt}`,
		type: 'send_cancelled',
		actor: args.userId ? userActor(args.userId) : { kind: 'system' },
		provenance: 'recorded',
		payload: { reason: args.reason },
	});
}

/** An approved reply waits for a file still being copied. */
export async function recordTeamSendHeld(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	args: { attachmentWaits: number; sendAt: number }
): Promise<void> {
	if (!message.threadId) return;
	await appendActivity(ctx, {
		threadRef: { kind: 'team', id: message.threadId },
		idempotencyKey: `send_held:${message._id}:${args.attachmentWaits}`,
		type: 'send_held',
		actor: { kind: 'system' },
		provenance: 'recorded',
		payload: { reason: 'attachment_copy', sendAt: args.sendAt },
	});
}

/**
 * Freeze what the team reply said, at finalization, before its interpretation
 * is enqueued: the source text must not move after the send (an edit, a
 * reopen). TODO(interpret lane): call the immutable sent-content snapshot
 * function here once it lands; until then the run reads the answered inbound
 * message's `draftResponse` (interpret.notes.md deviation 10).
 */
async function snapshotTeamReplyContent(
	_ctx: MutationCtx,
	_send: Pick<Doc<'transactionalSends'>, '_id' | 'inboundMessageId'>
): Promise<void> {}

/** A team reply's Send reached a terminal edge (see the module doc). */
export async function onTeamSendFinalized(
	ctx: MutationCtx,
	send: Pick<Doc<'transactionalSends'>, '_id' | 'inboundMessageId'>,
	outcome: { to: 'sent' | 'failed' | 'bounced'; at: number }
): Promise<void> {
	if (!send.inboundMessageId) return;
	const team = await teamThreadOf(ctx, send.inboundMessageId);
	if (!team) return;
	const opRef = { kind: 'outbound' as const, id: send._id };
	if (outcome.to === 'sent') {
		const isAuto = team.inbound.approvalSource === 'auto';
		const appended = await appendActivity(ctx, {
			threadRef: team.threadRef,
			idempotencyKey: `sent:${send._id}`,
			type: isAuto ? 'auto_sent' : 'reply_sent',
			actor: isAuto ? { kind: 'agent' } : { kind: 'user' },
			provenance: 'recorded',
			opRef,
			eventAt: outcome.at,
		});
		if (appended && !appended.isDuplicate) {
			await snapshotTeamReplyContent(ctx, send);
			await enqueueSentInterpretation(ctx, { kind: 'teamReply', id: send._id }, team.threadRef);
		}
		return;
	}
	await appendActivity(ctx, {
		threadRef: team.threadRef,
		idempotencyKey: `delivery_failed:${send._id}`,
		type: 'delivery_failed',
		actor: { kind: 'system' },
		provenance: 'recorded',
		opRef,
		eventAt: outcome.at,
		payload: { state: outcome.to },
	});
	await reconcileSendFailure(ctx, { kind: 'teamReply', id: send._id });
}
