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
 * transports live in `./outbound/dispatch.ts`.
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
	ScannedMalwareError,
	bufferDraftAttachments,
	buildOutboundMime,
	sealOutboundMessage,
} from './outbound/build';
import { dispatchViaExternalWorker, dispatchViaMta } from './outbound/dispatch';

export const dispatchDraft = internalAction({
	args: { draftId: v.id('mailDrafts'), undoToken: v.string() },
	handler: async (ctx, args) => {
		// Read the draft via the existing internalQuery surface. The
		// state/from-binding/undoToken checks all move into the
		// `transition({ to: 'sent' })` reducer where they're atomic with
		// the cascade. We still need a read-side fetch here because the
		// action has to build the RFC 5322 envelope from the draft body
		// BEFORE it can call the lifecycle.
		const draft = (await ctx.runQuery(internal.mail.drafts.getInternal, {
			draftId: args.draftId,
		})) as DraftRow | null;
		if (!draft) {
			logInfo(`[Outbound] Draft ${args.draftId} not found; skipping`);
			return;
		}
		if (draft.state !== 'pending_send' && draft.state !== 'scheduled') {
			logInfo(`[Outbound] Draft ${args.draftId} no longer in pending_send; skipping`);
			return;
		}
		// The undoToken is the dispatch's idempotency handle — if the row
		// has a fresh token now, this dispatch hop is stale (replay or
		// out-of-order delivery from a re-send).
		if (draft.undoToken !== args.undoToken) {
			logInfo(`[Outbound] Draft ${args.draftId} undoToken mismatch; skipping`);
			return;
		}

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
			if (err instanceof ScannedMalwareError) {
				logError(`[Outbound] Aborting draft ${args.draftId}: ${err.message}`);
				await ctx.runMutation(internal.mail.draftLifecycle.transition, {
					draftId: args.draftId,
					input: {
						to: 'draft',
						at: Date.now(),
						reason: 'scan_blocked',
					},
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
		// Consent is checked again after discovery and crypto because either can
		// change during the undo window. Never silently downgrade a normal Send to
		// plaintext; return the draft to the composer for an explicit choice.
		if (isFlagEnabled && !encryptionInfo.isSealed && !draft.isUnsealedSendAllowed) {
			logError(
				`[Outbound] Refusing unsealed dispatch for draft ${args.draftId}: explicit consent missing`
			);
			await ctx.runMutation(internal.mail.draftLifecycle.transition, {
				draftId: args.draftId,
				input: {
					to: 'draft',
					at: Date.now(),
					reason: 'seal_consent_required',
				},
			});
			return;
		}
		const storedSize = storedBytes.length;

		// Store the raw .eml in Convex storage — `storedBytes` is the E2EE-SEALED
		// wire bytes when Sealed Mail applied. Convert to Uint8Array first because
		// Blob's BlobPart type doesn't accept the Node Buffer<Shared|ArrayBuffer>
		// union directly under newer @types/node.
		const rawBytes = new Uint8Array(
			storedBytes.buffer,
			storedBytes.byteOffset,
			storedBytes.byteLength
		);
		// E8b: wrap the bytes in the AT-REST byte cipher so the stored sent copy is
		// ciphertext on disk. The outbound MTA / external-SMTP worker fetch the
		// `.eml` back through the `/sealed-blob` decrypt-serving proxy (see the
		// `rawEmlUrl` mint in outbound/dispatch.ts), so what goes on the wire is
		// the plaintext .eml.
		const rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');

		// Hand off to the lifecycle module — atomic with the six-table
		// cascade, draft row delete, attachment-blob cleanup, address-book
		// recording, and audit-log. The reducer re-checks the from-address
		// binding inside the transition; on revocation it returns
		// `from_revoked` and we drop back to `'draft'` ourselves.
		const sentOutcome: DraftTransitionOutcome = await ctx.runMutation(
			internal.mail.draftLifecycle.transition,
			{
				draftId: args.draftId,
				input: {
					to: 'sent',
					at: Date.now(),
					context: {
						rawStorageId,
						rawSize: storedSize,
						// Only stamp the row when Sealed Mail is live — a flag-off
						// deployment writes no `encryptionInfo`, byte-identical to today.
						...(isFlagEnabled ? { encryptionInfo } : {}),
						rfc822MessageId: rfc822MessageId.replace(/^<|>$/g, ''),
						inReplyToHeaderValue: inReplyToHeaderValue?.replace(/^<|>$/g, ''),
						references:
							referencesHeaderValue?.split(/\s+/).map((r) => r.replace(/^<|>$/g, '')) ?? [],
						bodyHtml: draft.bodyHtml,
						bodyText: draft.bodyText,
						attachmentsMeta: draft.attachments.map((att, idx) => ({
							filename: att.filename,
							contentType: att.contentType,
							size: att.size,
							contentId: att.contentId,
							partIndex: String(idx),
						})),
					},
				},
			}
		);

		if (!sentOutcome.ok) {
			if (sentOutcome.reason === 'from_revoked') {
				// With send-as, the allow-set that refused belongs to the SENDING
				// mailbox (the teammate's personal mailbox on a personal send-as),
				// not the thread mailbox — log the sending id so an operator debugging
				// a blocked send isn't pointed at the wrong mailbox.
				const revokedSendingMailboxId = draft.sendAsMailboxId ?? draft.mailboxId;
				logError(
					`[Outbound] Refusing to dispatch draft ${args.draftId}: from-address "${draft.fromAddress}" is not in the allowed set for sending mailbox ${revokedSendingMailboxId} (thread mailbox ${draft.mailboxId})`
				);
				// The cascade did not run; clean up the raw .eml we just stored
				// and revert the draft so the user can edit and retry.
				await ctx.storage.delete(rawStorageId).catch(() => {});
				await ctx.runMutation(internal.mail.draftLifecycle.transition, {
					draftId: args.draftId,
					input: {
						to: 'draft',
						at: Date.now(),
						reason: 'from_revoked',
					},
				});
				return;
			}
			logError(`[Outbound] Draft ${args.draftId} dispatch refused: ${sentOutcome.reason}`);
			await ctx.storage.delete(rawStorageId).catch(() => {});
			return;
		}

		const mailMessageId = sentOutcome.messageId;
		if (!mailMessageId) {
			logError(
				`[Outbound] Draft ${args.draftId} transitioned to sent but no messageId returned; skipping MTA dispatch`
			);
			return;
		}

		const recipients = [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses].filter(
			(r, i, arr) => arr.indexOf(r) === i
		);

		// Send-as choice: a shared-inbox reply sent from a teammate's personal
		// identity routes through THAT mailbox's transport and allow-set (not the
		// thread mailbox's). `sendAsMailboxId` is unset for the classic path, so
		// `sendingMailboxId` collapses to `draft.mailboxId` and behaviour is
		// unchanged. The reducer independently re-validates the binding.
		const sendingMailboxId = draft.sendAsMailboxId ?? draft.mailboxId;

		// Fetch the allowed-from set once and pass it into every MTA /send
		// call. This gives the MTA a hard "is this From authorized?" check
		// independent of Convex (defence-in-depth around the lifecycle's
		// reducer-side check). Keyed on the SENDING mailbox so the MTA-side
		// allowlist covers the sanctioned cross-mailbox identity too.
		const allowedFromAddresses = (await ctx.runQuery(
			internal.mail.identities.resolveAllowedFromAddresses,
			{ mailboxId: sendingMailboxId }
		)) as string[];

		// Branch transport on mailbox kind. External mailboxes send through the
		// user's own SMTP via the mail-sync worker (single POST, synchronous
		// per-recipient result); hosted mailboxes go per-recipient to the MTA.
		// Resolved from the sending mailbox so each identity uses its OWN transport.
		const transport = await ctx.runQuery(internal.mail.outboundTransport.resolveOutboundTransport, {
			mailboxId: sendingMailboxId,
		});
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
// row-delete fan-out moved to the Mail draft lifecycle (module) — see
// docs/adr/0028-mail-draft-lifecycle-module.md.
