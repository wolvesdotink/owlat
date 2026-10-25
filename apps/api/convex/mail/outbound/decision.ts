/**
 * The personal-mail dispatch's decisions, without storage, crypto or the
 * network: whether a dispatch hop may build the message at all, whether a
 * plaintext send needs consent it does not have, what the `→ sent` transition
 * records, and what the hop does with the lifecycle's answer. `../outbound.ts`
 * reads, builds, stores and calls the transports; the authoritative state,
 * undo-token and From checks stay atomic with the lifecycle's own writes
 * (`../draftLifecycle`), so these are prechecks and plans, never a substitute.
 *
 * PURE: nothing here reads a clock, a database or the environment
 * (scripts/purity-roots.txt).
 */

import type { Id } from '../../_generated/dataModel';
import type { RevertReason, SentInputContext, TransitionOutcome } from '../draftLifecycle/types';
import type { DraftRow } from '../rfc822';
import { unsealedSendNeedsConsent, type OutboundEncryptionInfo } from '../sealPolicy';

/** A line for the operator log. */
export interface DispatchLog {
	readonly level: 'info' | 'error';
	readonly message: string;
}

/**
 * Whether this hop may build the message. The undoToken is the dispatch's
 * idempotency handle: a row that carries a fresh token now means this hop is
 * stale (a replay, or out-of-order delivery from a re-send).
 */
export function decideDispatchStart<D extends Pick<DraftRow, 'state' | 'undoToken'>>(
	draftId: Id<'mailDrafts'>,
	draft: D | null,
	undoToken: string
):
	| { readonly kind: 'build'; readonly draft: D }
	| { readonly kind: 'skip'; readonly log: DispatchLog } {
	if (!draft) {
		return {
			kind: 'skip',
			log: { level: 'info', message: `[Outbound] Draft ${draftId} not found; skipping` },
		};
	}
	if (draft.state !== 'pending_send' && draft.state !== 'scheduled') {
		return {
			kind: 'skip',
			log: {
				level: 'info',
				message: `[Outbound] Draft ${draftId} no longer in pending_send; skipping`,
			},
		};
	}
	if (draft.undoToken !== undoToken) {
		return {
			kind: 'skip',
			log: { level: 'info', message: `[Outbound] Draft ${draftId} undoToken mismatch; skipping` },
		};
	}
	return { kind: 'build', draft };
}

/**
 * Does a send that came out unsealed need consent the draft does not carry?
 * Consent is checked again after discovery and crypto because either can
 * change during the undo window: a Send that could have been sealed is never
 * silently downgraded, it goes back to the composer for an explicit choice.
 * Ordinary mail to keyless recipients needs none.
 */
export function isUnsealedConsentMissing(input: {
	readonly isFlagEnabled: boolean;
	readonly encryptionInfo: OutboundEncryptionInfo;
	readonly isUnsealedSendAllowed: boolean | undefined;
}): boolean {
	return (
		input.isFlagEnabled &&
		!input.encryptionInfo.isSealed &&
		unsealedSendNeedsConsent(input.encryptionInfo.reason) &&
		!input.isUnsealedSendAllowed
	);
}

const unbracket = (value: string): string => value.replace(/^<|>$/g, '');

/** What the `→ sent` transition records about the stored message. */
export function sentContext(input: {
	readonly draft: Pick<DraftRow, 'bodyHtml' | 'bodyText' | 'attachments'>;
	readonly rawStorageId: Id<'_storage'>;
	readonly storedSize: number;
	readonly isFlagEnabled: boolean;
	readonly encryptionInfo: OutboundEncryptionInfo;
	readonly rfc822MessageId: string;
	readonly inReplyToHeaderValue: string | undefined;
	readonly referencesHeaderValue: string | undefined;
}): SentInputContext {
	const { draft } = input;
	return {
		rawStorageId: input.rawStorageId,
		rawSize: input.storedSize,
		// Only stamp the row when Sealed Mail is live — a flag-off deployment
		// writes no `encryptionInfo`.
		...(input.isFlagEnabled ? { encryptionInfo: input.encryptionInfo } : {}),
		rfc822MessageId: unbracket(input.rfc822MessageId),
		inReplyToHeaderValue:
			input.inReplyToHeaderValue === undefined ? undefined : unbracket(input.inReplyToHeaderValue),
		references: input.referencesHeaderValue?.split(/\s+/).map(unbracket) ?? [],
		bodyHtml: draft.bodyHtml,
		bodyText: draft.bodyText,
		attachmentsMeta: draft.attachments.map((att, idx) => ({
			filename: att.filename,
			contentType: att.contentType,
			size: att.size,
			contentId: att.contentId,
			partIndex: String(idx),
		})),
	};
}

/** What the hop does with the lifecycle's answer to `→ sent`. */
export type AfterSentPlan =
	| { readonly kind: 'transport'; readonly mailMessageId: Id<'mailMessages'> }
	| {
			readonly kind: 'stop';
			readonly log: DispatchLog;
			/** Drop the stored `.eml`: the cascade that would own it did not run. */
			readonly isRawDeleted: boolean;
			/** Return the draft to the composer for this reason. */
			readonly revert?: RevertReason;
	  };

export function decideAfterSent(
	draftId: Id<'mailDrafts'>,
	draft: Pick<DraftRow, 'fromAddress' | 'mailboxId' | 'sendAsMailboxId'>,
	outcome: TransitionOutcome
): AfterSentPlan {
	if (!outcome.ok) {
		if (outcome.reason === 'undo_token_mismatch') {
			// The send this hop was scheduled for was withdrawn while the message
			// was being built; the draft now belongs to another send (or to the
			// composer), which this hop must leave alone.
			return {
				kind: 'stop',
				log: {
					level: 'info',
					message: `[Outbound] Draft ${draftId} undoToken changed during dispatch; skipping`,
				},
				isRawDeleted: true,
			};
		}
		if (outcome.reason === 'from_revoked') {
			// With send-as, the allow-set that refused belongs to the SENDING
			// mailbox (the teammate's personal mailbox on a personal send-as), not
			// the thread mailbox, so the log names the sending id.
			return {
				kind: 'stop',
				log: {
					level: 'error',
					message: `[Outbound] Refusing to dispatch draft ${draftId}: from-address "${draft.fromAddress}" is not in the allowed set for sending mailbox ${sendingMailboxId(draft)} (thread mailbox ${draft.mailboxId})`,
				},
				isRawDeleted: true,
				revert: 'from_revoked',
			};
		}
		return {
			kind: 'stop',
			log: {
				level: 'error',
				message: `[Outbound] Draft ${draftId} dispatch refused: ${outcome.reason}`,
			},
			isRawDeleted: true,
		};
	}
	if (!outcome.messageId) {
		// The Sent row owns the stored copy now, so it stays.
		return {
			kind: 'stop',
			log: {
				level: 'error',
				message: `[Outbound] Draft ${draftId} transitioned to sent but no messageId returned; skipping MTA dispatch`,
			},
			isRawDeleted: false,
		};
	}
	return { kind: 'transport', mailMessageId: outcome.messageId };
}

/** Every recipient once, in To, Cc, Bcc order. */
export function dispatchRecipients(
	draft: Pick<DraftRow, 'toAddresses' | 'ccAddresses' | 'bccAddresses'>
): string[] {
	return [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses].filter(
		(r, i, arr) => arr.indexOf(r) === i
	);
}

/**
 * The mailbox the message goes out through. A shared-inbox reply sent from a
 * teammate's personal identity uses THAT mailbox's transport and allow-set;
 * without send-as it is the thread mailbox.
 */
export function sendingMailboxId(
	draft: Pick<DraftRow, 'mailboxId' | 'sendAsMailboxId'>
): Id<'mailboxes'> {
	return draft.sendAsMailboxId ?? draft.mailboxId;
}
