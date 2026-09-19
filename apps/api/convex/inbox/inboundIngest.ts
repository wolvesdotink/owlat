/**
 * Team-inbox ingest — the raw-bytes half of `POST /webhooks/mta-inbound`.
 *
 * Seals the received `.eml`, scans its attachment leaves for malware, persists
 * the message, and then — only for a message that is not confirmed malware —
 * captures its attachments into the semantic file library so they reach the
 * agent's `[RELEVANT FILES]` retrieval.
 *
 * NOT `'use node'`. Like `mail/delivery.ts`, this runs in the Convex V8 isolate
 * (which has no `Buffer`; `lib/bytes.ts` owns the conversions) and delegates to
 * Node actions through `ctx.runAction` where one is needed. Adding `'use node'`
 * would move the whole module's runtime.
 *
 * ORDERING IS THE INVARIANT: the row is inserted BEFORE capture, and capture is
 * wrapped so it cannot throw outward. Mail that arrived is never lost to a
 * failure in the optional enrichment that follows it.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { base64ToBytes, bytesToBinaryString } from '../lib/bytes';
import { storeSealedBlob } from '../lib/sealedBlob';
import { getMtaConfig } from '../mail/mtaClient';
import { scanInboundAttachments } from '../mail/deliveryPipeline/scan';
import { captureAttachments } from '../mail/deliveryPipeline/ingest';
import { logError } from '../lib/runtimeLog';
import { receiveInboundMail } from './receiveInbound';

/**
 * The normalized inbound message, as `webhooks/adapters/inboundRegistry.ts`
 * produces it. Mirrors `InboundEmailMessage` field for field; the two are kept
 * in step by the handler's assignment, which is a compile error when they drift.
 */
const inboundMailValidator = v.object({
	from: v.string(),
	to: v.string(),
	subject: v.string(),
	textBody: v.optional(v.string()),
	htmlBody: v.optional(v.string()),
	headers: v.record(v.string(), v.string()),
	messageId: v.string(),
	inReplyTo: v.optional(v.string()),
	references: v.optional(v.string()),
	attachments: v.array(
		v.object({
			filename: v.optional(v.string()),
			contentType: v.string(),
			size: v.number(),
			partIndex: v.optional(v.string()),
		})
	),
	timestamp: v.number(),
	spfResult: v.optional(v.string()),
	dkimResult: v.optional(v.string()),
	dmarcResult: v.optional(v.string()),
	dmarcPolicy: v.optional(v.string()),
});

export const ingestFromWebhook = internalAction({
	args: {
		mail: inboundMailValidator,
		/**
		 * The whole message as base64 RFC822. Optional: an MTA older than the
		 * route split, or a DLQ event queued before it, delivers the same mail
		 * with no bytes. That message is stored normally — it just has no raw
		 * blob, no attachments and no antivirus verdict.
		 */
		rawBytesBase64: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ inboundMessageId: Id<'inboundMessages'> }> => {
		let rawStorageId: Id<'_storage'> | undefined;
		let rawSize: number | undefined;
		let rawBinary: string | undefined;
		let virusVerdict: 'clean' | 'infected' | 'skipped' | undefined;

		if (args.rawBytesBase64) {
			const rawBytes = base64ToBytes(args.rawBytesBase64);
			rawSize = rawBytes.byteLength;
			// E8b: sealed at rest under INSTANCE_SECRET (plaintext passthrough when
			// unset). The reader's download re-serves it through /sealed-blob.
			rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');
			rawBinary = bytesToBinaryString(rawBytes);

			// Defense-in-depth on the receiving side: ClamAV lives in the MTA
			// container, so each non-inline leaf is POSTed to its /scan/attachment.
			// `undefined` here means NOTHING WAS SCANNED — either the scanner is not
			// configured or there are no attachment leaves — and the two are
			// indistinguishable, so no verdict is asserted. Storing `undefined` as
			// `'clean'` would be a claim we cannot make.
			const scanned = await scanInboundAttachments(getMtaConfig(), rawBinary);
			virusVerdict = scanned === 'infected' ? 'infected' : scanned;
		}

		const { inboundMessageId } = await receiveInboundMail(ctx, args.mail, {
			rawStorageId,
			rawSize,
			virusVerdict,
		});

		// CONFIRMED MALWARE: nothing is extracted, nothing is indexed, nothing
		// reaches a model. `receiveMessage` has already quarantined the row and
		// skipped the agent pipeline. The sealed blob deliberately STAYS, so an
		// operator can still investigate what was sent — the message is never
		// dropped, it is only stopped from being acted on.
		if (virusVerdict === 'infected' || !rawBinary) {
			return { inboundMessageId };
		}

		// Attachment capture is best-effort by construction and runs AFTER the
		// insert, so it cannot fail delivery. The file-type allowlist, the
		// per-part size ceilings, the 10-part cap, the sender→contact scoping and
		// the AI-ingest budget all live inside `captureAttachments`, shared with
		// the personal-mailbox route so the two cannot enforce different policy.
		try {
			await captureAttachments(ctx, rawBinary, args.mail.messageId, args.mail.from);
		} catch (err) {
			logError('[Inbound Webhook] attachment capture failed', err);
		}

		return { inboundMessageId };
	},
});
