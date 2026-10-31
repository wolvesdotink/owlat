'use node';

/**
 * Outbound dispatch for personal-mail drafts.
 *
 * 1. Marks the draft as dispatching (atomic check on state)
 * 2. Builds a minimal RFC 5322 multipart message from draft fields + attachments
 * 3. Stores raw .eml in ctx.storage
 * 4. Inserts a mailMessages row in the Sent folder (outbound.state='queued')
 * 5. POSTs to the existing MTA /send endpoint per recipient
 * 6. Deletes the draft row
 *
 * This file is the orchestrating action. Steps 2 and 3's message assembly
 * (attachment buffering + scan, threading headers, body rendering, RFC 5322
 * build, Sealed Mail sealing) live in `./outbound/build.ts`; step 5's two
 * transports live in `./outbound/dispatch.ts`; the pure decisions between the
 * steps (skip a stale hop, refuse without consent, the sent record, what the
 * lifecycle's answer means) live in `./outbound/decision.ts`.
 *
 * MTA delivery webhooks (sent/bounced) flow back to /webhooks/mta and
 * update mailMessages.outbound.state — see webhooks/adapters/mta.ts and the
 * `pb-` branch of webhooks/dispatcher.ts.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logInfo } from '../lib/runtimeLog';
import { storeSealedBlob } from '../lib/sealedBlob';
import { getMtaConfig } from './mtaClient';
import type { TransitionOutcome as DraftTransitionOutcome } from './draftLifecycle/types';
import type { DraftRow } from './rfc822';
import {
	BlockedAttachmentError,
	bufferDraftAttachments,
	buildOutboundMime,
	sealOutboundMessage,
} from './outbound/build';
import { dispatchViaExternalWorker, dispatchViaMta } from './outbound/dispatch';
import {
	decideAfterSent,
	decideDispatchStart,
	dispatchRecipients,
	isUnsealedConsentMissing,
	sendingMailboxId,
	sentContext,
	type DispatchLog,
} from './outbound/decision';

function writeLog(log: DispatchLog): void {
	if (log.level === 'info') logInfo(log.message);
	else logError(log.message);
}

export const dispatchDraft = internalAction({
	args: { draftId: v.id('mailDrafts'), undoToken: v.string() },
	handler: async (ctx, args) => {
		// Read the draft via the existing internalQuery surface. The
		// state/from-binding/undoToken checks are repeated by every lifecycle
		// transition below (each passes `expectedUndoToken`), atomic with its
		// write. We still need a read-side fetch here because the action has
		// to build the RFC 5322 envelope from the draft body BEFORE it can
		// call the lifecycle.
		const loaded = (await ctx.runQuery(internal.mail.drafts.getInternal, {
			draftId: args.draftId,
		})) as DraftRow | null;
		const start = decideDispatchStart(args.draftId, loaded, args.undoToken);
		if (start.kind === 'skip') {
			writeLog(start.log);
			return;
		}
		const { draft } = start;

		// Fetch attachment bytes — and scan each one through MTA's ClamAV
		// endpoint before letting it ship. On confirmed malware we abort the
		// dispatch and revert the draft so the user sees it in the composer.
		// Fail-open on scanner outage — matches the campaign-mail path in
		// emailWorker.ts.
		let attachmentBuffers;
		try {
			const buffered = await bufferDraftAttachments(ctx, draft);
			draft.bodyHtml = buffered.inlinedHtml;
			attachmentBuffers = buffered.attachments;
		} catch (err) {
			if (err instanceof BlockedAttachmentError) {
				logError(`[Outbound] Aborting draft ${args.draftId}: ${err.message}`);
				await ctx.runMutation(internal.mail.draftLifecycle.transition, {
					draftId: args.draftId,
					expectedUndoToken: args.undoToken,
					input: { to: 'draft', at: Date.now(), reason: 'scan_blocked' },
				});
				return;
			}
			throw err;
		}

		const { raw, rfc822MessageId, inReplyToHeaderValue, referencesHeaderValue } =
			await buildOutboundMime(ctx, draft, attachmentBuffers);

		// Sealed Mail (E3): signed+encrypted PGP/MIME when policy and every
		// recipient's pinned key allow it; honest plaintext with a recorded reason
		// otherwise.
		const { storedBytes, sealed, encryptionInfo, isFlagEnabled } = await sealOutboundMessage(
			ctx,
			draft,
			raw
		);
		if (
			isUnsealedConsentMissing({
				isFlagEnabled,
				encryptionInfo,
				isUnsealedSendAllowed: draft.isUnsealedSendAllowed,
			})
		) {
			logError(
				`[Outbound] Refusing unsealed dispatch for draft ${args.draftId}: explicit consent missing`
			);
			await ctx.runMutation(internal.mail.draftLifecycle.transition, {
				draftId: args.draftId,
				expectedUndoToken: args.undoToken,
				input: { to: 'draft', at: Date.now(), reason: 'seal_consent_required' },
			});
			return;
		}

		// Store the raw .eml — `storedBytes` is the E2EE-SEALED wire bytes when
		// Sealed Mail applied — wrapped in the AT-REST byte cipher, so the sent
		// copy is ciphertext on disk. The MTA / external-SMTP worker fetch it back
		// through the `/sealed-blob` decrypt-serving proxy (see the `rawEmlUrl`
		// mint in outbound/dispatch.ts). Blob's BlobPart type does not accept the
		// Node Buffer union under newer @types/node, hence the Uint8Array view.
		const rawBytes = new Uint8Array(
			storedBytes.buffer,
			storedBytes.byteOffset,
			storedBytes.byteLength
		);
		const rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');

		// Hand off to the lifecycle module — atomic with the six-table
		// cascade, draft row delete, attachment-blob cleanup, address-book
		// recording, and audit-log. The reducer re-checks the from-address
		// binding inside the transition; on revocation it returns
		// `from_revoked`, and the same commit has already put the draft back.
		const sentOutcome: DraftTransitionOutcome = await ctx.runMutation(
			internal.mail.draftLifecycle.commitSent,
			{
				draftId: args.draftId,
				expectedUndoToken: args.undoToken,
				input: {
					to: 'sent',
					at: Date.now(),
					context: sentContext({
						draft,
						rawStorageId,
						storedSize: storedBytes.length,
						isFlagEnabled,
						encryptionInfo,
						rfc822MessageId,
						inReplyToHeaderValue,
						referencesHeaderValue,
					}),
				},
			}
		);

		const afterSent = decideAfterSent(args.draftId, draft, sentOutcome);
		if (afterSent.kind === 'stop') {
			writeLog(afterSent.log);
			if (afterSent.isRawDeleted) await ctx.storage.delete(rawStorageId).catch(() => {});
			return;
		}

		const { mailMessageId } = afterSent;
		const recipients = dispatchRecipients(draft);
		const sendingMailbox = sendingMailboxId(draft);

		// Two independent reads, side by side. The allowed-from set goes into
		// every MTA /send call, so the MTA checks "is this From authorized?"
		// independently of Convex (defence-in-depth around the reducer's check).
		// The transport branches on mailbox kind: external mailboxes send through
		// the user's own SMTP via the mail-sync worker, hosted ones go
		// per-recipient to the MTA. Both are keyed on the SENDING mailbox, so a
		// send-as identity uses its own allow-set and transport.
		const [allowedFromAddresses, transport] = await Promise.all([
			ctx.runQuery(internal.mail.identities.resolveAllowedFromAddresses, {
				mailboxId: sendingMailbox,
			}) as Promise<string[]>,
			ctx.runQuery(internal.mail.outboundTransport.resolveOutboundTransport, {
				mailboxId: sendingMailbox,
			}),
		]);
		if (transport.kind === 'external') {
			await dispatchViaExternalWorker(ctx, {
				externalAccountId: transport.externalAccountId,
				mailMessageId,
				fromAddress: draft.fromAddress,
				recipients,
				rawStorageId,
				rfc822MessageId,
			});
			return;
		}

		await dispatchViaMta(ctx, {
			draft,
			sealed,
			mailMessageId,
			recipients,
			rfc822MessageId,
			inReplyToHeaderValue,
			referencesHeaderValue,
			allowedFromAddresses,
			mta: getMtaConfig(),
		});
	},
});

// `getMessage` lives in mailOutboundQueries.ts so it can run in the v8
// isolate (Convex requires query definitions to be non-`'use node'`).
// The send-success cascade, the per-revert reverts, and the recipient/
// row-delete fan-out moved to the Mail draft lifecycle (module).
