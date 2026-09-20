/**
 * Team-inbox ingest — the raw-bytes half of `POST /webhooks/mta-inbound`.
 *
 * Seals the received `.eml`, scans its attachment leaves for malware, persists
 * the message, and then — only for a message whose attachments came back
 * CLEAN — captures them into the semantic file library so they reach the
 * agent's `[RELEVANT FILES]` retrieval.
 *
 * NOT `'use node'`. Like `mail/delivery.ts`, this runs in the Convex V8 isolate
 * (which has no `Buffer`; `lib/bytes.ts` owns the conversions) and delegates to
 * Node actions through `ctx.runAction` where one is needed. Adding `'use node'`
 * would move the whole module's runtime.
 *
 * ORDERING IS THE INVARIANT: the row is inserted BEFORE capture, and every step
 * after it is wrapped so it cannot throw outward. Mail that arrived is never
 * lost to a failure in the optional enrichment that follows it — and the staged
 * blob is dropped on every exit that does not end in a row referencing it, so a
 * failure leaves no orphan bytes behind either.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { base64ToBytes, bytesToBinaryString } from '../lib/bytes';
import { storeSealedBlob } from '../lib/sealedBlob';
import { getMtaConfig } from '../mail/mtaClient';
import { scanInboundAttachments } from '../mail/deliveryPipeline/scan';
import { captureAttachments } from '../mail/deliveryPipeline/ingest';
import type { AttachmentCaptureOutcome } from '../mail/deliveryPipeline/ingest';
import { inboundEmailMessageValidator } from '../webhooks/adapters/inboundRegistry';
import type { AttachmentIndexing, VirusVerdict } from '../lib/literalValidators';
import { logError, logWarn } from '../lib/runtimeLog';
import { receiveInboundMail } from './receiveInbound';

/** A staged raw message: sealed into storage, decoded, and scanned. */
type StagedRaw = {
	rawStorageId: Id<'_storage'>;
	rawSize: number;
	/** The byte-preserving binary-string projection the MIME walker needs. */
	rawBinary: string;
	/**
	 * `undefined` means NOTHING WAS SCANNED — either the scanner is not
	 * configured or there are no attachment leaves — and the two are
	 * indistinguishable, so no verdict is asserted. Storing `undefined` as
	 * `'clean'` would be a claim we cannot make.
	 */
	virusVerdict?: VirusVerdict;
};

/**
 * Decode, seal and scan the raw message, or answer `null` when there is
 * nothing usable to seal.
 *
 * Its own step so the handler below reads as pre-check → stage → persist →
 * capture, rather than as four `let`s filled in one branch and consumed in
 * five.
 */
async function stageRawMessage(
	ctx: ActionCtx,
	rawBytesBase64: string,
	messageId: string
): Promise<StagedRaw | null> {
	const rawBytes = base64ToBytes(rawBytesBase64);
	// `base64ToBytes` answers undecodable input with ZERO BYTES rather than
	// throwing (`lib/bytes.ts` says so, and says the ingest paths must refuse it
	// themselves). A real RFC822 message is never empty, so a zero-byte decode is
	// a corrupt payload, not a message: sealing it would write a `rawStorageId`
	// the reader believes in and offer a download that extracts nothing and can
	// never be retried into working. Fall through to the no-raw path instead,
	// which renders honestly.
	if (rawBytes.byteLength === 0) {
		logWarn('[Inbound Webhook] rawBytesBase64 decoded to zero bytes — stored without raw', {
			messageId,
		});
		return null;
	}

	// E8b: sealed at rest under INSTANCE_SECRET (plaintext passthrough when
	// unset). The reader's download re-serves it through /sealed-blob.
	const rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');
	const rawBinary = bytesToBinaryString(rawBytes);

	// Defense-in-depth on the receiving side: ClamAV lives in the MTA container,
	// so each non-inline leaf is POSTed to its /scan/attachment.
	//
	// NEVER THROWS OUTWARD. The scan walks attacker-supplied MIME, and a walker
	// that threw here — a truncated multipart, a header the parser chokes on —
	// would 500 the route on a message the MTA has already accepted over SMTP,
	// which means six retries and then the DLQ. An unscannable message is
	// treated as unscanned: it is stored, listed and downloadable, and nothing
	// in it is ever fed to a model.
	let virusVerdict: VirusVerdict | undefined;
	try {
		virusVerdict = await scanInboundAttachments(getMtaConfig(), rawBinary);
	} catch (err) {
		logError('[Inbound Webhook] attachment scan failed — message stored unscanned', err);
		virusVerdict = 'skipped';
	}

	return { rawStorageId, rawSize: rawBytes.byteLength, rawBinary, virusVerdict };
}

export const ingestFromWebhook = internalAction({
	args: {
		mail: inboundEmailMessageValidator,
		/**
		 * The whole message as base64 RFC822. Optional: an MTA older than the
		 * route split, or a DLQ event queued before it, delivers the same mail
		 * with no bytes — and so does a message whose payload did not fit the
		 * action-argument budget. That message is stored normally — it just has
		 * no raw blob, no attachments and no antivirus verdict.
		 */
		rawBytesBase64: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ inboundMessageId: Id<'inboundMessages'>; isDuplicate: boolean }> => {
		// IDEMPOTENCY, first pass. The MTA gives its webhook fetch 10 s and then
		// retries — but aborting the client does not stop this action, so a slow
		// scan means the same message arrives again while the first attempt is
		// still running. The transactional check is inside `receiveMessage`; this
		// one is here to avoid re-sealing a 10 MiB blob and re-running up to ten
		// ClamAV round-trips for a message we have already stored.
		const alreadyStored: Id<'inboundMessages'> | null = await ctx.runQuery(
			internal.inbox.messages.findIdByMessageId,
			{ messageId: args.mail.messageId, from: args.mail.from, to: args.mail.to }
		);
		if (alreadyStored) {
			return { inboundMessageId: alreadyStored, isDuplicate: true };
		}

		const staged = args.rawBytesBase64
			? await stageRawMessage(ctx, args.rawBytesBase64, args.mail.messageId)
			: null;

		let received;
		try {
			received = await receiveInboundMail(ctx, args.mail, {
				rawStorageId: staged?.rawStorageId,
				rawSize: staged?.rawSize,
				virusVerdict: staged?.virusVerdict,
			});
		} catch (err) {
			// The blob was sealed before the row was written, so a mutation that
			// throws — a transient db error, a scheduler failure — would otherwise
			// leave bytes nothing references and the retention sweep never sees
			// (it walks rows, not storage). Drop them and let the MTA retry into a
			// clean slate.
			await dropStagedBlob(ctx, staged?.rawStorageId, args.mail.messageId);
			throw err;
		}
		const { inboundMessageId, isDuplicate } = received;

		// Lost the race with a concurrent retry: the transactional check inside
		// `receiveMessage` found the row this attempt was about to duplicate. Drop
		// the blob we staged — nothing references it — and stop before capture, so
		// the attachment budget is charged once per message rather than once per
		// MTA retry.
		if (isDuplicate) {
			await dropStagedBlob(ctx, staged?.rawStorageId, args.mail.messageId);
			return { inboundMessageId, isDuplicate: true };
		}

		// CONFIRMED MALWARE: nothing is extracted, nothing is indexed, nothing
		// reaches a model. `receiveMessage` has already quarantined the row and
		// skipped the agent pipeline. The sealed blob deliberately STAYS, so an
		// operator can still investigate what was sent — the message is never
		// dropped, it is only stopped from being acted on.
		if (!staged || staged.virusVerdict === 'infected') {
			return { inboundMessageId, isDuplicate: false };
		}

		// NOTHING UNSCANNED REACHES A MODEL. Capture runs on a `'clean'` verdict
		// and on nothing else. `'skipped'` means the scanner was configured and
		// unreachable; `undefined` means it is not configured at all (or there was
		// no attachment leaf to scan, in which case there is nothing to capture
		// anyway). Feeding either to summarise + embed + knowledge extraction
		// would hand attacker-supplied bytes to the model on a route any sender
		// can reach. The message, its metadata and its downloadable `.eml` all
		// still exist — and the row says why nothing was indexed, so the reader
		// can say it too instead of rendering an unindexed file like an indexed
		// one.
		if (staged.virusVerdict !== 'clean') {
			// Only worth recording when there was something to index: a plain
			// message with no attachment leaves is not "unscanned", it is empty.
			if (args.mail.attachments.length > 0) {
				await markIndexing(ctx, inboundMessageId, 'skipped_unscanned');
			}
			return { inboundMessageId, isDuplicate: false };
		}

		// Attachment capture is best-effort by construction and runs AFTER the
		// insert, so it cannot fail delivery. The file-type allowlist, the
		// per-part size ceilings, the 10-part cap, the sender→contact scoping and
		// the AI-ingest budget all live inside `captureAttachments`, shared with
		// the personal-mailbox route so the two cannot enforce different policy.
		try {
			const outcome = await captureAttachments(ctx, {
				rawBinary: staged.rawBinary,
				messageId: args.mail.messageId,
				from: args.mail.from,
				// Only team-inbox captures are in range of the inbound retention
				// sweep — the personal mailbox keeps its files permanently.
				captureSource: 'team_inbox',
				// A `From:` that DMARC failed is not evidence of who sent this, so
				// the files are not filed under the contact it claimed to be.
				dmarcResult: args.mail.dmarcResult,
			});
			await recordCaptureOutcome(ctx, inboundMessageId, outcome);
		} catch (err) {
			logError('[Inbound Webhook] attachment capture failed', err);
		}

		return { inboundMessageId, isDuplicate: false };
	},
});

/**
 * Drop a raw blob no row will ever reference.
 *
 * Never throws: every caller is on a path where the mail is already handled,
 * and turning a leaked blob into a 500 would make the MTA retry a delivery that
 * is complete. A failure is logged instead, because otherwise it is invisible —
 * the retention sweep walks rows, and no row points here.
 */
async function dropStagedBlob(
	ctx: ActionCtx,
	rawStorageId: Id<'_storage'> | undefined,
	messageId: string
): Promise<void> {
	if (!rawStorageId) return;
	try {
		await ctx.storage.delete(rawStorageId);
	} catch (err) {
		logWarn('[Inbound Webhook] could not drop the staged raw blob', { messageId, err });
	}
}

/**
 * Turn what capture did into the marker the thread view reads.
 *
 * EVERY outcome is recorded, not just the budget one: a part refused for its
 * size or its type is exactly as unread by the assistant as one the budget
 * refused, and an unmarked row renders as though the file had been indexed.
 */
async function recordCaptureOutcome(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	outcome: AttachmentCaptureOutcome
): Promise<void> {
	const marker: AttachmentIndexing | undefined =
		outcome.skippedReason === 'budget'
			? 'skipped_budget'
			: outcome.skippedReason === 'too_large'
				? 'skipped_too_large'
				: outcome.skippedReason === 'unsupported_type'
					? 'skipped_unsupported'
					: outcome.indexed > 0
						? 'indexed'
						: undefined;
	if (marker) await markIndexing(ctx, inboundMessageId, marker);
}

/** Record the capture outcome on the row; never fails the ingest. */
async function markIndexing(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	attachmentIndexing: AttachmentIndexing
): Promise<void> {
	try {
		await ctx.runMutation(internal.inbox.messages.setAttachmentIndexing, {
			inboundMessageId,
			attachmentIndexing,
		});
	} catch (err) {
		// The mail is already stored. A marker that could not be written is a
		// reader losing one line of context, not a delivery to retry — and the
		// contract this function advertises to its five call sites is that it
		// never fails the ingest, which only a catch here makes true.
		logError('[Inbound Webhook] could not record attachment indexing', err);
	}
}
