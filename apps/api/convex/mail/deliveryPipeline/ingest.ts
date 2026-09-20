/**
 * Personal-mail delivery pipeline — the Node-side ingest step.
 *
 * Everything the `mail/delivery.ts::ingestFromWebhook` action does BEFORE it
 * hands the message to the `deliverToMailbox` mutation: raw MIME staging,
 * decrypt-on-ingest, inbound signature verification, body inline/blob split
 * and the aggregate malware verdict. What happens to the cleared attachment
 * leaves AFTER delivery is `./capture.ts`.
 *
 * Action-only: every function here needs `ctx.storage` and/or `ctx.runAction`.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { extractAntiLoopHeaders } from '../../lib/inboundClassification';
import { extractListUnsubscribe } from '@owlat/shared/listUnsubscribe';
import { logError } from '../../lib/runtimeLog';
import type { VirusVerdict } from '../../lib/literalValidators';
import { getMtaConfig } from '../mtaClient';
import {
	isSealedPgpMime,
	usableRestoredBodies,
	type InboundEncryptionInfo,
} from '../../e2ee/inboundSeal';
import type { InboundSignatureInfo } from '../../e2ee/inboundSignature';
import { isClearsigned, isSignedPgpMime } from '@owlat/shared/secureMessage';
import { storeSealedBlob, type BlobStore } from '../../lib/sealedBlob';
import { base64ToBytes, bytesToBinaryString, utf8Bytes } from '../../lib/bytes';
import { buildSnippet } from './insert';
import { buildSearchBody } from '../searchBody';
import { scanInboundAttachments } from './scan';

const INLINE_BODY_THRESHOLD_BYTES = 64 * 1024;

/**
 * Inline a parsed body when it fits the threshold; otherwise stash it as a
 * storage blob so the reader can lazy-fetch it. Bodies over the threshold are
 * NOT stored inline on the row (they'd bloat every list read and can exceed
 * Convex value limits) — previously they were simply dropped, so newsletters /
 * long threads rendered blank. Action-only (needs `ctx.storage.store`).
 */
export async function splitBodyForStorage(
	ctx: { storage: BlobStore },
	body: string | undefined,
	contentType: string
): Promise<{ inline?: string; storageId?: Id<'_storage'> }> {
	if (!body) return {};
	// Encoded ONCE: the threshold is a byte count (`body.length` counts UTF-16
	// code units and under-counts every non-ASCII character), and the same bytes
	// are what gets stored when it is over.
	const bytes = utf8Bytes(body);
	if (bytes.byteLength <= INLINE_BODY_THRESHOLD_BYTES) {
		return { inline: body };
	}
	// E8b: seal the over-threshold body blob at rest (byte cipher). The reader
	// (`readMailMessageText`) and the web-reader proxy both unseal transparently.
	const storageId = await storeSealedBlob(ctx.storage, bytes, contentType);
	return { storageId };
}

/**
 * Stage an inbound message for the delivery mutation: decode + store the raw
 * `.eml`, parse the header-derived fields, decrypt-on-ingest, verify an inbound
 * PGP signature, split the (possibly restored) bodies for storage, and resolve
 * the aggregate malware verdict.
 *
 * Returns everything `deliverToMailbox` needs plus the staged storage ids, so
 * the caller can drop them again when delivery is skipped.
 */
export async function prepareInboundMessage(
	ctx: ActionCtx,
	args: {
		rawBytesBase64: string;
		recipientAddress: string;
		from: string;
		subject: string;
		textBody?: string;
		htmlBody?: string;
		virusVerdict?: VirusVerdict;
	}
) {
	// Decode raw MIME and stash in Convex storage. `base64ToBytes` answers
	// undecodable input with zero bytes rather than throwing; a real RFC822
	// message is never empty, so refuse it here instead of delivering an empty
	// row with a zero-byte `.eml` behind it.
	const rawBytes = base64ToBytes(args.rawBytesBase64);
	if (rawBytes.length === 0) {
		throw new Error('prepareInboundMessage: rawBytesBase64 decoded to zero bytes');
	}
	const rawSize = rawBytes.length;
	// MIME extraction needs the byte-preserving binary-string projection. It is
	// expensive for large messages, so build it once and thread the same value to
	// malware scanning and semantic attachment capture.
	const rawBinary = bytesToBinaryString(rawBytes);
	// Raw header block decoded once (64KB covers any header section) for both
	// extractions below.
	const rawHeaderBlock = new TextDecoder().decode(rawBytes.subarray(0, 65536));
	// RFC 3834 anti-loop headers so forwarding + vacation hooks skip
	// list/auto-submitted mail.
	const antiLoopHeaders = extractAntiLoopHeaders(rawHeaderBlock);
	// List-Unsubscribe / List-Unsubscribe-Post (RFC 2369 / 8058), parsed once
	// here so the reader's Unsubscribe chip never re-opens the raw .eml.
	const unsubscribe = extractListUnsubscribe(rawHeaderBlock) ?? undefined;
	// The raw `.eml` we store IS the E2EE-sealed original when the message
	// arrived sealed — decrypt-on-ingest keeps that ciphertext downloadable
	// (D3) while the row's body columns below carry the restored plaintext.
	// E8b then wraps the bytes in the AT-REST byte cipher so a storage dump
	// holds no plaintext; the reader path + `/sealed-blob` proxy unseal it.
	const rawStorageId = await storeSealedBlob(ctx.storage, rawBytes, 'message/rfc822');

	// Sealed Mail (E4, D3): decrypt-on-ingest. When the message arrived as
	// PGP/MIME ciphertext AND we hold the recipient's vault key, open it here so
	// the RESTORED plaintext (real Subject + bodies) flows into the normal
	// pipeline (threading, categorize, needs-reply, agent, knowledge, search). A
	// message we cannot decrypt — or any plaintext message, or when the flag is
	// off — falls straight through to the existing path unchanged. The honest
	// outcome is recorded on the row as `inboundEncryptionInfo`.
	//
	// The structural check is pure + cheap, so a PLAINTEXT message (the common
	// case, and the default while the flag is off) never spawns the `'use node'`
	// open action — it would only return `{ sealed: false }` anyway. Mirrors the
	// cheap `extractArmoredCiphertext` pre-gate the AI-inbox path already uses
	// before its decrypt action.
	const opened = isSealedPgpMime(rawHeaderBlock)
		? await ctx.runAction(internal.e2ee.open.openInboundForMailbox, {
				rawBytesBase64: args.rawBytesBase64,
				recipientAddress: args.recipientAddress,
				from: args.from,
			})
		: ({ isSealed: false } as const);

	// Inbound PGP signature verification (F1, D9): a message that arrived
	// SIGNED but not encrypted (RFC 3156 multipart/signed or an inline
	// clearsigned body) gets its signature verified server-side and the honest
	// verdict persisted beside the row. Same cheap structural pre-gate pattern
	// as the sealed check above, so plaintext mail (the common case) never
	// spawns the `'use node'` verify action. Fail-open by construction: the
	// action never throws, and even if it did the message still delivers with
	// an honest `verification_error` verdict — signature verification adds
	// data, never blocks delivery (D10).
	let inboundSignatureInfo: InboundSignatureInfo | undefined;
	if (!opened.isSealed && (isSignedPgpMime(rawBinary) || isClearsigned(rawBinary))) {
		try {
			const verdict = await ctx.runAction(internal.e2ee.verifyInboundSignature.forInbound, {
				rawBytesBase64: args.rawBytesBase64,
				from: args.from,
			});
			if (verdict.isSigned) inboundSignatureInfo = verdict.info;
		} catch (err) {
			logError('[Mail Webhook] inbound signature verification failed', err);
			inboundSignatureInfo = {
				isSigned: true,
				isSignatureValid: false,
				keySource: 'not_found',
				failure: 'verification_error',
			};
		}
	}
	let effectiveSubject = args.subject;
	let effectiveText = args.textBody;
	let effectiveHtml = args.htmlBody;
	let inboundEncryptionInfo: InboundEncryptionInfo | undefined;
	if (opened.isSealed) {
		inboundEncryptionInfo = opened.encryptionInfo;
		if (opened.isDecrypted) {
			// Restored plaintext (real Subject + bodies, D4) replaces the outer
			// placeholder + ciphertext so the normal pipeline sees real content.
			if (opened.subject !== undefined) effectiveSubject = opened.subject;
			// Fail-safe: only replace when the restore yields a usable body — see
			// usableRestoredBodies.
			const bodies = usableRestoredBodies(opened);
			if (bodies) {
				effectiveText = bodies.text;
				effectiveHtml = bodies.html;
			}
		}
	}

	// Inline small bodies for a fast list/reader render; stash larger bodies
	// as separate blobs (served lazily by mailbox.messages.getMessageBody).
	const textBody = await splitBodyForStorage(ctx, effectiveText, 'text/plain; charset=utf-8');
	const htmlBody = await splitBodyForStorage(ctx, effectiveHtml, 'text/html; charset=utf-8');
	// Snippet from the FULL body, before the inline/blob split, so >64KB
	// bodies still get a non-empty preview + search snippet.
	const snippet = buildSnippet(effectiveText, effectiveHtml);
	// Deep-search excerpt (idea 32), computed from the same pre-split body for the
	// same reason: the depth worth finding in a long message is precisely the part
	// that ends up in a blob. Computed unconditionally and cheap; whether it is
	// PERSISTED is decided by the instance opt-in in `insertDeliveredMessage`.
	const searchBody = buildSearchBody(effectiveText, effectiveHtml);

	// Scan inbound attachments for malware (defense-in-depth on the receiving
	// side). ClamAV lives in the MTA container, so we POST each attachment leaf
	// to its `/scan/attachment` endpoint. A confirmed-infected verdict routes
	// the message to Spam/quarantine in `deliverToMailbox`; a scanner outage
	// fails open with a `'skipped'` verdict (the message still delivers, and
	// the skip is surfaced via `scannerHealth.warnScanSkipped`). The verdict the
	// MTA pipeline already set on `args` is merged in there (infected wins).
	const scan = await scanInboundAttachments(getMtaConfig(), rawBinary, args.virusVerdict);

	return {
		rawBinary,
		// The scan's cleared leaves travel WITH the verdict: capture takes the
		// parts, never a second walk of the same bytes, so the set that was
		// scanned and the set that reaches a model are one set by construction.
		scan,
		rawSize,
		rawStorageId,
		antiLoopHeaders,
		unsubscribe,
		// Restored real subject (D4) when the message was opened; the outer
		// placeholder `...` otherwise. Threading downstream keys off this.
		subject: effectiveSubject,
		text: textBody,
		html: htmlBody,
		snippet,
		searchBody,
		virusVerdict: scan.verdict,
		inboundEncryptionInfo,
		inboundSignatureInfo,
	};
}
