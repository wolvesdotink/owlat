/**
 * Compose draft lifecycle for personal mailboxes.
 *
 * - create/update mutations are debounced autosave targets
 * - send/cancelPendingSend delegate to the Mail draft lifecycle module
 *   which is the sole writer of `mailDrafts.state` and its companion fields
 *   (`scheduledSendAt`, `undoToken`). See ADR-0028.
 *
 * Drafts live in mailDrafts (separate from mailMessages) so autosaves
 * don't pollute the Drafts folder visible to IMAP. On final send the
 * draft row is deleted and a new mailMessages row is inserted in Sent
 * (with outbound.state='queued') by the Mail draft lifecycle module's
 * `→ sent` reducer (invoked from the dispatch action in mail/outbound.ts).
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedMutation, authedQuery, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { normalizeEmail } from '@owlat/shared';
import { requireMailboxAccess } from './permissions';
import { resolveSendAsIdentitiesForCtx } from './identities';
import { getOrThrow, throwForbidden, throwInvalidState, throwNotFound } from '../_utils/errors';
import { assertStateIs, type TransitionOutcome as DraftTransitionOutcome } from './draftLifecycle';
import { markOnboardingStep } from '../auth/userOnboarding';
import { getMailSyncConfig, getMtaConfig } from './mtaClient';
import { resolveMailboxTransport } from './outboundTransport';
import { isFeatureEnabled } from '../lib/featureFlags';
import { hasActiveSigningKey, loadRecipientKeyStates } from './outboundQueries';
import { deriveSealState, type SealState } from './sealPolicy';

/**
 * True iff this mailbox actually has an outbound transport to ship the message —
 * the honest gate behind the onboarding "first send" milestone. Resolves through
 * the SAME decision the dispatcher uses (`resolveMailboxTransport`) so the gate
 * can never disagree with where the message really goes: a hosted mailbox ships
 * through the MTA, a connected external mailbox through the mail-sync worker.
 * Stamping `firstSendDone` on an instance that can't dispatch this mailbox would
 * let a member "complete" a send that is silently dropped.
 */
async function mailboxHasSendTransport(
	ctx: QueryCtx | MutationCtx,
	mailbox: Doc<'mailboxes'>
): Promise<boolean> {
	const transport = await resolveMailboxTransport(ctx, mailbox);
	return transport.kind === 'external' ? getMailSyncConfig() !== null : getMtaConfig() !== null;
}

/**
 * Member-safe signal for "can a test send from this mailbox actually leave the
 * instance?" — the honest client gate behind the fresh-start "email myself"
 * step. Wraps the SAME server-side helper as the send-time `firstSendDone`
 * stamp, so the button and the completion never disagree. Returns false (rather
 * than throwing) when the mailbox isn't accessible, so the caller renders the
 * "still being set up" state instead of an error.
 */
export const canSendFrom = authedQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<boolean> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return false;
		return mailboxHasSendTransport(ctx, owned.mailbox);
	},
});

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		inReplyToMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const mailbox = owned.mailbox;

		const now = Date.now();
		let threadId: Id<'mailThreads'> | undefined;
		let inReplySubject: string | undefined;
		let inReplyFrom: string | undefined;
		let toAddresses: string[] = [];
		let subject = '';
		// Only persist the reply linkage when the referenced message lives in
		// the SAME mailbox. Forwarding an arbitrary id would let a send-time
		// effect (runSentEffects' flagAnswered patch) write into another user's
		// mailbox — a cross-mailbox IDOR. Leave undefined otherwise.
		let inReplyToMessageId: Id<'mailMessages'> | undefined;

		if (args.inReplyToMessageId) {
			const original = await ctx.db.get(args.inReplyToMessageId);
			if (original && original.mailboxId === args.mailboxId) {
				inReplyToMessageId = args.inReplyToMessageId;
				threadId = original.threadId;
				inReplyFrom = original.fromAddress;
				inReplySubject = original.subject;
				toAddresses = [original.replyToAddress ?? original.fromAddress];
				subject = original.subject.match(/^re\s*:\s*/i)
					? original.subject
					: `Re: ${original.subject}`;
			}
		}

		const draftId: Id<'mailDrafts'> = await ctx.runMutation(internal.mail.draftLifecycle.create, {
			mailboxId: args.mailboxId,
			fromAddress: mailbox.address,
			inReplyToMessageId,
			threadId,
			toAddresses,
			subject,
			at: now,
		});

		return { draftId, inReplySubject, inReplyFrom };
	},
});

export const update = authedMutation({
	args: {
		draftId: v.id('mailDrafts'),
		toAddresses: v.optional(v.array(v.string())),
		ccAddresses: v.optional(v.array(v.string())),
		bccAddresses: v.optional(v.array(v.string())),
		subject: v.optional(v.string()),
		bodyHtml: v.optional(v.string()),
		bodyText: v.optional(v.string()),
		bodyBlocks: v.optional(v.string()),
		composerMode: v.optional(v.union(v.literal('simple'), v.literal('full'))),
		// "Remind me if no reply by…" — a timestamp arms it, `null` clears it,
		// absent leaves it untouched. Carried onto the sent thread as a
		// follow-up watch by the sent-effects reducer (mail/followUps.ts).
		followUpRemindAt: v.optional(v.union(v.number(), v.null())),
		// Edit-learning flywheel: the composer passes the AI's ORIGINAL draft text
		// here the first time it applies an AI-generated draft. Snapshotted ONCE
		// (never overwritten) so a later human edit still diffs against the AI's
		// version on send. Absent → no learning, exactly today's behaviour.
		aiBaseline: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');

		const patch: Record<string, unknown> = { lastEditedAt: Date.now() };
		if (args.toAddresses !== undefined) patch['toAddresses'] = args.toAddresses;
		if (args.ccAddresses !== undefined) patch['ccAddresses'] = args.ccAddresses;
		if (args.bccAddresses !== undefined) patch['bccAddresses'] = args.bccAddresses;
		if (args.subject !== undefined) patch['subject'] = args.subject;
		if (args.bodyHtml !== undefined) patch['bodyHtml'] = args.bodyHtml;
		if (args.bodyText !== undefined) patch['bodyText'] = args.bodyText;
		if (args.bodyBlocks !== undefined) patch['bodyBlocks'] = args.bodyBlocks;
		if (args.composerMode !== undefined) patch['composerMode'] = args.composerMode;
		if (args.followUpRemindAt !== undefined) {
			patch['followUpRemindAt'] = args.followUpRemindAt ?? undefined;
		}
		// Snapshot the AI baseline exactly once — the first apply wins so a later
		// human edit still diffs against the AI's original text on send.
		if (
			args.aiBaseline !== undefined &&
			args.aiBaseline.trim().length > 0 &&
			draft.aiDraftBaseline === undefined
		) {
			patch['aiDraftBaseline'] = { text: args.aiBaseline, capturedAt: Date.now() };
		}

		await ctx.db.patch(args.draftId, patch);
		return { savedAt: patch['lastEditedAt'] };
	},
});

/**
 * Switch the From identity for a draft. The address MUST be one of the
 * sanctioned send-as identities for this draft: the thread mailbox's own
 * allowed-from set (canonical address or active alias) OR — in a shared (team)
 * inbox — an allowed-from address of one of the acting teammate's OWN personal
 * mailboxes. Picking a personal identity records `sendAsMailboxId` so dispatch
 * routes through that mailbox's transport and lands the sent copy there.
 *
 * This is the only user-facing path that sets `fromAddress`/`sendAsMailboxId`;
 * `update` does not accept them, and the dispatch-time re-check independently
 * re-validates the binding if any future path lets a foreign address slip
 * through. The allow-set is extended to sanctioned cross-mailbox identities,
 * never bypassed — everything else is still rejected.
 */
export const setIdentity = authedMutation({
	args: {
		draftId: v.id('mailDrafts'),
		fromAddress: v.string(),
	},
	handler: async (ctx, args) => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');

		const candidate = normalizeEmail(args.fromAddress);
		const identities = await resolveSendAsIdentitiesForCtx(ctx, owned.mailbox, owned.userId);
		const match = identities.find((i) => i.address === candidate);
		if (!match) {
			throwForbidden('From address not authorized for this mailbox');
		}

		await ctx.db.patch(args.draftId, {
			fromAddress: candidate,
			// Personal send-as ⇒ record the sending mailbox; team/own identity ⇒
			// clear it so the classic path (transport + Sent copy on the thread
			// mailbox) runs unchanged.
			sendAsMailboxId: match.mailboxId === draft.mailboxId ? undefined : match.mailboxId,
			lastEditedAt: Date.now(),
		});
	},
});

export const addAttachment = authedMutation({
	args: {
		draftId: v.id('mailDrafts'),
		storageId: v.id('_storage'),
		filename: v.string(),
		contentType: v.string(),
		size: v.number(),
		isInline: v.optional(v.boolean()),
		contentId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');

		await ctx.db.patch(args.draftId, {
			attachments: [
				...draft.attachments,
				{
					storageId: args.storageId,
					filename: args.filename,
					contentType: args.contentType,
					size: args.size,
					isInline: args.isInline ?? false,
					contentId: args.contentId,
				},
			],
			lastEditedAt: Date.now(),
		});
		// Return a truthy result so callers can distinguish success from the
		// undefined that useBackendOperation.run yields on a failed/void call.
		return { ok: true };
	},
});

export const removeAttachment = authedMutation({
	args: { draftId: v.id('mailDrafts'), storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return;

		const toDelete = draft.attachments.find((a) => a.storageId === args.storageId);
		await ctx.db.patch(args.draftId, {
			attachments: draft.attachments.filter((a) => a.storageId !== args.storageId),
			lastEditedAt: Date.now(),
		});
		if (toDelete) {
			await ctx.storage.delete(toDelete.storageId);
		}
		return { ok: true };
	},
});

export const discard = authedMutation({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args) => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return;
		for (const att of draft.attachments) {
			await ctx.storage.delete(att.storageId);
		}
		await ctx.db.delete(args.draftId);
	},
});

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const get = publicQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args) => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return null;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return null;
		return draft;
	},
});

/**
 * Composer seal state for a draft (Sealed Mail E5, flag `sealedMail`). A
 * `publicQuery` soft-auth wrapper (returns `null` for anonymous callers) that
 * scopes the draft to the caller's mailbox in-handler via `requireMailboxAccess`.
 * Answers, for the compose surface: would sending now seal (`willSeal`), which
 * recipients' keys rotated without a signed statement (`keyChanged`), or why it
 * cannot seal (`cannotSeal`). Feeds the SAME pure `deriveSealState` the same
 * inputs the dispatch path (`getOutboundSealInputs` → `decideSeal`) reads — the
 * per-recipient key states AND the sender's signing-key presence AND the org
 * policy — so the composer's promise can never drift from what the sender
 * actually does (a mailbox without a minted signing key, or an `ask`/`off`
 * policy, resolves to `cannotSeal`, never a false "will be sealed"). Reads only
 * PUBLIC trust state — never any private key material. Returns `null` (rather
 * than throwing) when the draft is gone or the caller can't access its mailbox,
 * so the composer renders no lock instead of an error.
 */
// public: soft-auth — returns null for anonymous; mailbox access is enforced in-handler
export const getComposerSealState = publicQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<SealState | null> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return null;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return null;
		if (!(await isFeatureEnabled(ctx, 'sealedMail'))) {
			return { kind: 'cannotSeal', reason: 'flag_off' };
		}
		const settings = await ctx.db.query('instanceSettings').first();
		const policy = settings?.sealPolicy ?? 'auto';
		const recipients = await loadRecipientKeyStates(ctx, [
			...draft.toAddresses,
			...draft.ccAddresses,
			...draft.bccAddresses,
		]);
		const hasSigningKey = await hasActiveSigningKey(ctx, draft.fromAddress);
		return deriveSealState(policy, recipients, hasSigningKey);
	},
});

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listForMailbox = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailDrafts')
			.withIndex('by_mailbox_and_edited', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(100);
	},
});

/**
 * Initiate send: mark draft as pending_send with an undo window, schedule
 * the actual dispatch action. Returns an undoToken the client can use to
 * cancel within the window.
 *
 * Body delegates to the Mail draft lifecycle module — sole writer of
 * `mailDrafts.state` and `undoToken`. See ADR-0028.
 */
export const send = authedMutation({
	args: {
		draftId: v.id('mailDrafts'),
		undoSendDelayMs: v.optional(v.number()),
		scheduledSendAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<{ undoToken: string; sendAt: number }> => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');

		// Record WHO is sending (team-inbox attribution). The dispatch runs later
		// in a session-less scheduled action, so the acting user must be captured
		// here; the sent-effects reducer copies it onto the message + thread.
		if (draft.sentByUserId !== owned.userId) {
			await ctx.db.patch(args.draftId, { sentByUserId: owned.userId });
		}

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
	},
});

/**
 * Cancel a pending_send draft (undo-send within the window).
 * Returns the draft to `state='draft'`. Body delegates to the Mail
 * draft lifecycle module's token-keyed entry point. See ADR-0028.
 */
export const cancelPendingSend = authedMutation({
	args: { undoToken: v.string() },
	handler: async (ctx, args): Promise<{ ok: false } | { ok: true; draftId: Id<'mailDrafts'> }> => {
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
	},
});

/**
 * Cancel a scheduled send and return the draft to `state='draft'` so the
 * user can edit, reschedule, or discard it. Keyed by `draftId` (not the
 * undo token, which is only surfaced in the transient undo-send toast and
 * is unavailable across the days until a scheduled send fires).
 *
 * Body delegates to the Mail draft lifecycle module's `scheduled → draft`
 * edge (reason `user_cancel`) — the sole writer of `mailDrafts.state`. The
 * already-scheduled `dispatchDraft` action no-ops once the row is back in
 * `'draft'` (it re-checks state + undoToken before sending). See ADR-0028.
 */
export const cancelScheduledSend = authedMutation({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<{ ok: false } | { ok: true; draftId: Id<'mailDrafts'> }> => {
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
	},
});

// ── Internal helpers used by the Node-side dispatch action ──

export const getInternal = internalQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args) => ctx.db.get(args.draftId),
});
