/**
 * Mail draft lifecycle (module) — single writer of `mailDrafts.state`,
 * `scheduledSendAt`, `undoToken`, and the multi-table send-success cascade.
 *
 * Owns the three-state machine `draft → pending_send | scheduled → draft (revert) |
 * sent (terminal, deletes the row)`. Three entry points: `create` (initial
 * insert), `transition` (direct, by draftId), and `transitionByUndoToken`
 * (undo-button path keyed by `undoToken`). Reducers return { patch, effects,
 * applied }; the runner is the only place that touches the DB or the
 * scheduler.
 *
 * This file is the dispatcher's public-function surface. The typed contract
 * lives in `./draftLifecycle/types.ts`, the legal-edge graph + pure reducers in
 * `./draftLifecycle/reducers.ts`, and the effect runner + `dispatch` in
 * `./draftLifecycle/effects.ts` — the same three-way split as the sibling
 * `inbox/processingLifecycle`. The status-owning mutations keep their
 * `internal.mail.draftLifecycle.*` paths.
 *
 * Effects per transition kind:
 *   → pending_send / scheduled:
 *     - schedule_dispatch_action       — schedules mail.outbound.dispatchDraft
 *     - audit_log('postbox_draft.send_initiated')
 *   → draft (revert):
 *     - audit_log(<reason-specific literal>)
 *   → sent (terminal):
 *     - insert_mail_message            — new mailMessages row in Sent
 *     - patch_sent_folder              — uidNext / modseq / totalCount
 *     - patch_thread                   — messageCount / lastMessageAt / ...
 *     - patch_in_reply_to_flag         — flagAnswered: true (if applicable)
 *     - patch_mailbox_bytes            — usedBytes += rawSize
 *     - delete_attachment_storage      — frees the draft's attachment blobs
 *     - record_recipients_in_address_book
 *     - delete_draft_row               — terminal row delete
 *     - audit_log('postbox_draft.sent')
 *
 * See docs/adr/0028-mail-draft-lifecycle-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { logError } from '../lib/runtimeLog';
import { isFeatureEnabled } from '../lib/featureFlags';
import { hasActiveSigningKey, loadRecipientKeyStates } from './outboundQueries';
import { deriveSealState, type SealState } from './sealPolicy';
import { dispatch } from './draftLifecycle/effects';
import { transitionInputValidator, type TransitionOutcome } from './draftLifecycle/types';

/**
 * Initial-insert path. The first writer of `mailDrafts.state` (with the
 * literal `'draft'`). All other writes to `state` go through `transition`.
 *
 * Called by the user-facing `api.mail.drafts.create` mutation, which already
 * does the mailbox-permission check.
 */
export const create = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		fromAddress: v.string(),
		inReplyToMessageId: v.optional(v.id('mailMessages')),
		threadId: v.optional(v.id('mailThreads')),
		toAddresses: v.array(v.string()),
		subject: v.string(),
		at: v.number(),
		// Offline-outbox idempotency key (the queued item's id) — see
		// `drafts.create`, which dedupes on it before calling here.
		clientNonce: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'mailDrafts'>> => {
		return await ctx.db.insert('mailDrafts', {
			mailboxId: args.mailboxId,
			linkedMessageId: undefined,
			inReplyToMessageId: args.inReplyToMessageId,
			threadId: args.threadId,
			toAddresses: args.toAddresses,
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: args.fromAddress,
			subject: args.subject,
			bodyHtml: '',
			bodyText: undefined,
			attachments: [],
			clientNonce: args.clientNonce,
			state: 'draft',
			lastEditedAt: args.at,
			createdAt: args.at,
		});
	},
});

/**
 * Apply a draft transition by draftId. Sole writer of `mailDrafts.state` and
 * its companion fields (`scheduledSendAt`, `undoToken`).
 *
 * Atomic with: state patch, scheduler.runAt (for `→ pending_send`/`scheduled`),
 * the six-table send-success cascade (for `→ sent`), audit_log effects, and
 * row deletion (for `→ sent`). Duplicate / illegal / terminal transitions are
 * reported via TransitionOutcome — never thrown.
 */
export const transition = internalMutation({
	args: {
		draftId: v.id('mailDrafts'),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) {
			return { ok: false, reason: 'draft_not_found', draftId: args.draftId };
		}
		const outcome = await dispatch(ctx, draft, args.input);
		// Log reverts so an operator can see why a draft popped back to
		// Drafts unexpectedly. The audit-log row carries the structured
		// reason; the runtime log is for live debugging.
		if (outcome.ok && args.input.to === 'draft' && args.input.reason !== 'user_cancel') {
			logError(`[DraftLifecycle] Reverted draft ${args.draftId} → 'draft': ${args.input.reason}`);
		}
		return outcome;
	},
});

/**
 * Same as `transition`, but keyed by `undoToken` rather than draftId. Used by
 * the user-facing `api.mail.drafts.cancelPendingSend` mutation which receives
 * the opaque undo handle from the client.
 *
 * Refuses any `input.to !== 'draft'` — the undo-token surface is undo-only.
 * Returns `already_draft` if the token's row is already in `'draft'` (the
 * undo button double-fire case).
 */
export const transitionByUndoToken = internalMutation({
	args: {
		undoToken: v.string(),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		if (args.input.to !== 'draft') {
			return { ok: false, reason: 'illegal_edge' };
		}
		const draft = await ctx.db
			.query('mailDrafts')
			.withIndex('by_undo_token', (q) => q.eq('undoToken', args.undoToken))
			.first();
		if (!draft) {
			return { ok: false, reason: 'undo_token_mismatch' };
		}
		if (draft.state === 'draft') {
			return {
				ok: true,
				applied: 'recorded',
				draftId: draft._id,
				from: 'draft',
				to: 'draft',
			};
		}
		return await dispatch(ctx, draft, args.input);
	},
});

// ─── Sealed Mail: per-draft seal state ────────────────────────────────────────

/**
 * The composer-facing seal readiness for a draft (Sealed Mail E3 → consumed by
 * the E5 compose surface): would sending NOW seal (`willSeal`), which recipients'
 * keys rotated without a signed statement (`keyChanged`), or why it cannot seal
 * (`cannotSeal`). Reads only PUBLIC trust state (recipient outcomes, the sender's
 * signing-key presence, and the org policy) — never any private key material.
 * The `sealedMail` flag gates it.
 * Internal: E5 wraps it in an authed compose query that already scopes the draft
 * to the caller's mailbox.
 */
export const getSealState = internalQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<SealState> => {
		const draft = await ctx.db.get(args.draftId);
		// A missing draft is a genuine not-found — NOT "no recipients". Throw rather
		// than return a mislabelled `cannotSeal` state the E5 composer would render
		// as a wrong explanation (the caller already scopes the draft to the mailbox
		// before asking, so a miss here means the row was deleted mid-compose).
		if (!draft) throw new Error(`getSealState: draft ${args.draftId} not found`);
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
