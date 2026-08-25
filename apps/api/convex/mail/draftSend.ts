/**
 * Send-side handlers for personal-mail drafts: initiating a send (immediate or
 * scheduled), undoing one inside the undo window, and unscheduling a future
 * one. Split out of `mail/drafts.ts` (the public mutation surface, which keeps
 * the thin wrappers so the generated function paths are unchanged), the same
 * way `mail/draftQueries.ts` holds the read side.
 *
 * Every state write still goes through the Mail draft lifecycle module — the
 * sole writer of `mailDrafts.state`, `scheduledSendAt` and `undoToken`. See
 * ADR-0028.
 */

import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden, throwInvalidState, throwNotFound } from '../_utils/errors';
import type { TransitionOutcome as DraftTransitionOutcome } from './draftLifecycle/types';
import { markOnboardingStep } from '../auth/userOnboarding';
import { isFeatureEnabled } from '../lib/featureFlags';
import { canSendWithSealState } from './sealPolicy';
import { mailboxHasSendTransport } from './draftQueries';

/**
 * Initiate send: mark draft as pending_send with an undo window, schedule
 * the actual dispatch action. Returns an undoToken the client can use to
 * cancel within the window.
 */
export async function sendHandler(
	ctx: MutationCtx,
	args: {
		draftId: Id<'mailDrafts'>;
		undoSendDelayMs?: number;
		scheduledSendAt?: number;
		allowUnsealed?: boolean;
	}
): Promise<{ undoToken: string; sendAt: number }> {
	const draft = await getOrThrow(ctx, args.draftId, 'Draft');
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) throwForbidden('Draft not accessible');

	let isUnsealedSendAllowed = false;
	if (await isFeatureEnabled(ctx, 'sealedMail')) {
		const sealState = await ctx.runQuery(internal.mail.draftLifecycle.getSealState, {
			draftId: args.draftId,
		});
		if (!canSendWithSealState(sealState, args.allowUnsealed === true)) {
			throwInvalidState(
				sealState.kind === 'keyChanged'
					? 'A recipient sealing key changed and must be confirmed before sending'
					: 'Explicit confirmation is required to send this message unsealed'
			);
		}
		isUnsealedSendAllowed = sealState.kind === 'cannotSeal' && args.allowUnsealed === true;
	}

	// Record WHO is sending (team-inbox attribution). The dispatch runs later
	// in a session-less scheduled action, so the acting user must be captured
	// here; the sent-effects reducer copies it onto the message + thread.
	await ctx.db.patch(args.draftId, {
		sentByUserId: owned.userId,
		isUnsealedSendAllowed,
	});

	const now = Date.now();
	const outcome: DraftTransitionOutcome = await ctx.runMutation(
		internal.mail.draftLifecycle.transition,
		{
			draftId: args.draftId,
			input: args.scheduledSendAt
				? {
						to: 'scheduled',
						at: now,
						scheduledSendAt: args.scheduledSendAt,
					}
				: {
						to: 'pending_send',
						at: now,
						undoSendDelayMs: args.undoSendDelayMs,
					},
		}
	);

	if (!outcome.ok) {
		switch (outcome.reason) {
			case 'illegal_edge':
				throwInvalidState('Draft already sending');
			case 'no_recipients':
				throwInvalidState('No recipients');
			case 'draft_not_found':
				throwNotFound('Draft');
			default:
				throwInvalidState(`Cannot send draft: ${outcome.reason}`);
		}
	}

	// First send from this instance completes the member's onboarding
	// "firstSendDone" step (idempotent — only the first send ever writes it).
	// This is what the fresh-start welcome's optional "email yourself" step
	// rides on. Gate it on a real transport: on an instance that can't
	// dispatch this mailbox's mail the message is silently dropped, so
	// recording a completion would be a lie. Every legitimate send (which by
	// definition has a transport) still stamps it, for every send.
	if (await mailboxHasSendTransport(ctx, owned.mailbox)) {
		await markOnboardingStep(ctx, owned.userId, 'firstSendDone');
	}

	return { undoToken: outcome.undoToken!, sendAt: outcome.sendAt! };
}

/**
 * Cancel a pending_send draft (undo-send within the window).
 * Returns the draft to `state='draft'` via the lifecycle module's
 * token-keyed entry point.
 */
export async function cancelPendingSendHandler(
	ctx: MutationCtx,
	args: { undoToken: string }
): Promise<{ ok: false } | { ok: true; draftId: Id<'mailDrafts'> }> {
	// Ownership check before delegating — the undo token alone isn't
	// enough to authenticate the caller.
	const draft = await ctx.db
		.query('mailDrafts')
		.withIndex('by_undo_token', (q) => q.eq('undoToken', args.undoToken))
		.first();
	if (!draft) return { ok: false };
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) return { ok: false };

	const outcome: DraftTransitionOutcome = await ctx.runMutation(
		internal.mail.draftLifecycle.transitionByUndoToken,
		{
			undoToken: args.undoToken,
			input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
		}
	);

	if (!outcome.ok) return { ok: false };
	return { ok: true, draftId: outcome.draftId };
}

/**
 * Cancel a scheduled send and return the draft to `state='draft'` so the
 * user can edit, reschedule, or discard it. Keyed by `draftId` (not the
 * undo token, which is only surfaced in the transient undo-send toast and
 * is unavailable across the days until a scheduled send fires).
 *
 * The already-scheduled `dispatchDraft` action no-ops once the row is back in
 * `'draft'` (it re-checks state + undoToken before sending).
 */
export async function cancelScheduledSendHandler(
	ctx: MutationCtx,
	args: { draftId: Id<'mailDrafts'> }
): Promise<{ ok: false } | { ok: true; draftId: Id<'mailDrafts'> }> {
	const draft = await getOrThrow(ctx, args.draftId, 'Draft');
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) throwForbidden('Draft not accessible');

	const outcome: DraftTransitionOutcome = await ctx.runMutation(
		internal.mail.draftLifecycle.transition,
		{
			draftId: args.draftId,
			input: { to: 'draft', at: Date.now(), reason: 'user_cancel' },
		}
	);

	if (!outcome.ok) {
		// `illegal_edge` here means the draft wasn't scheduled (or already
		// dispatched) — treat as a soft no-op rather than throwing so the
		// UI can simply re-render from the live query.
		return { ok: false };
	}
	return { ok: true, draftId: outcome.draftId };
}
