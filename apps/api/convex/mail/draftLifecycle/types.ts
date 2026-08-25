/**
 * Mail draft lifecycle — typed contract (no logic).
 *
 * The `DraftState` / `RevertReason` literal unions, the `TransitionInput`
 * discriminated union + its Convex validator, the `Effect` / `ReducerResult`
 * shapes the reducers produce, and the `TransitionOutcome` the dispatcher
 * returns. Pure types + validators — no runtime branching lives here. The
 * state graph and per-transition reducers are in `./reducers.ts`; the effect
 * runner + dispatcher are in `./effects.ts`.
 *
 * See docs/adr/0028-mail-draft-lifecycle-module.md.
 */

import { v } from 'convex/values';
import { mailMessageAttachmentValidator } from '../../lib/convexValidators';
import type { Doc, Id } from '../../_generated/dataModel';
import { mailEncryptionInfoValidator, type OutboundEncryptionInfo } from '../sealPolicy';

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_UNDO_SEND_DELAY_MS = 30_000;

// ─── States / inputs / outcomes ─────────────────────────────────────────────

export type DraftState = 'draft' | 'pending_send' | 'scheduled';

export type RevertReason =
	| 'user_cancel'
	| 'from_revoked'
	| 'scan_blocked'
	| 'seal_consent_required';

export interface SentInputContext {
	rawStorageId: Id<'_storage'>;
	rawSize: number;
	// Sealed Mail (E3): the outbound sealing outcome. Present on the personal-mail
	// send path; the raw `.eml` at `rawStorageId` is ciphertext when `sealed`.
	encryptionInfo?: OutboundEncryptionInfo;
	rfc822MessageId: string;
	inReplyToHeaderValue?: string;
	references: string[];
	bodyHtml: string;
	bodyText?: string;
	attachmentsMeta: Array<{
		filename: string;
		contentType: string;
		size: number;
		contentId?: string;
		partIndex: string;
	}>;
}

export type TransitionInput =
	| { to: 'pending_send'; at: number; undoSendDelayMs?: number }
	| { to: 'scheduled'; at: number; scheduledSendAt: number }
	| { to: 'draft'; at: number; reason: RevertReason }
	| { to: 'sent'; at: number; context: SentInputContext };

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			draftId: Id<'mailDrafts'>;
			from: DraftState;
			to: TransitionInput['to'];
			// Populated for `→ pending_send` / `→ scheduled` so the caller can
			// hand back the undo handle to the user.
			undoToken?: string;
			sendAt?: number;
			// Populated for `→ sent` so callers (the dispatcher) can chain
			// per-recipient MTA POSTs against the new row.
			messageId?: Id<'mailMessages'>;
	  }
	| {
			ok: false;
			reason:
				| 'draft_not_found'
				| 'illegal_edge'
				| 'no_recipients'
				| 'from_revoked'
				| 'undo_token_mismatch'
				| 'already_draft'
				| 'sent_folder_missing';
			draftId?: Id<'mailDrafts'>;
			from?: DraftState;
			to?: TransitionInput['to'];
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

const sentInputContextValidator = v.object({
	rawStorageId: v.id('_storage'),
	rawSize: v.number(),
	encryptionInfo: v.optional(mailEncryptionInfoValidator),
	rfc822MessageId: v.string(),
	inReplyToHeaderValue: v.optional(v.string()),
	references: v.array(v.string()),
	bodyHtml: v.string(),
	bodyText: v.optional(v.string()),
	attachmentsMeta: v.array(mailMessageAttachmentValidator),
});

export const transitionInputValidator = v.union(
	v.object({
		to: v.literal('pending_send'),
		at: v.number(),
		undoSendDelayMs: v.optional(v.number()),
	}),
	v.object({
		to: v.literal('scheduled'),
		at: v.number(),
		scheduledSendAt: v.number(),
	}),
	v.object({
		to: v.literal('draft'),
		at: v.number(),
		reason: v.union(
			v.literal('user_cancel'),
			v.literal('from_revoked'),
			v.literal('scan_blocked'),
			v.literal('seal_consent_required')
		),
	}),
	v.object({
		to: v.literal('sent'),
		at: v.number(),
		context: sentInputContextValidator,
	})
);

// ─── Effects ────────────────────────────────────────────────────────────────

export type AuditLogEffect = {
	kind: 'audit_log';
	action:
		| 'postbox_draft.send_initiated'
		| 'postbox_draft.sent'
		| 'postbox_draft.cancelled'
		| 'postbox_draft.from_revoked'
		| 'postbox_draft.scan_blocked'
		| 'postbox_draft.seal_consent_required';
	draftId: Id<'mailDrafts'>;
	mailboxId: Id<'mailboxes'>;
	details: Record<string, string | number | boolean>;
};

export type Effect =
	| {
			kind: 'schedule_dispatch_action';
			draftId: Id<'mailDrafts'>;
			undoToken: string;
			sendAt: number;
	  }
	| AuditLogEffect
	| {
			kind: 'delete_attachment_storage';
			storageIds: ReadonlyArray<Id<'_storage'>>;
	  }
	| {
			kind: 'record_recipients_in_address_book';
			mailboxId: Id<'mailboxes'>;
			emails: ReadonlyArray<string>;
	  }
	| {
			// Edit-learning flywheel: the sent draft carried an AI baseline, so
			// diff baseline → sent out of band and fold the delta into the voice
			// profile / per-contact memory (mail/ai/editLearning.ts). Fire-and-forget;
			// never blocks the send.
			kind: 'schedule_edit_learning';
			mailboxId: Id<'mailboxes'>;
			contactAddress?: string;
			baselineText: string;
			sentText: string;
	  };

export type ReducerResult = {
	patch: Partial<Doc<'mailDrafts'>>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
	extras?: {
		undoToken?: string;
		sendAt?: number;
		// Only set on the `→ sent` reducer's result; the runner inserts the
		// mailMessages row and threads the id back into the outcome.
		sentContext?: SentInputContext;
	};
};
