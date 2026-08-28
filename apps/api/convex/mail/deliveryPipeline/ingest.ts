/**
 * Personal-mail delivery pipeline — the Node-side ingest step.
 *
 * Everything the `mail/delivery.ts::ingestFromWebhook` action does BEFORE it
 * hands the message to the `deliverToMailbox` mutation: raw MIME staging,
 * decrypt-on-ingest, inbound signature verification, body inline/blob split,
 * the aggregate malware verdict — plus the post-delivery attachment capture
 * into the semantic file library.
 *
 * Action-only: every function here needs `ctx.storage` and/or `ctx.runAction`.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { extractEmail } from '../../lib/emailAddress';
import { extractAntiLoopHeaders } from '../../lib/inboundClassification';
import { extractAttachments } from '@owlat/shared/mailMime';
import { extractListUnsubscribe } from '@owlat/shared/listUnsubscribe';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { logError } from '../../lib/runtimeLog';
import { getMtaConfig } from '../mtaClient';
import {
	isSealedPgpMime,
	usableRestoredBodies,
	type InboundEncryptionInfo,
} from '../../e2ee/inboundSeal';
import type { InboundSignatureInfo } from '../../e2ee/inboundSignature';
import { isClearsigned, isSignedPgpMime } from '@owlat/shared/secureMessage';
import { storeSealedBlob, type BlobStore } from '../../lib/sealedBlob';
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
	if (Buffer.byteLength(body, 'utf-8') <= INLINE_BODY_THRESHOLD_BYTES) {
		return { inline: body };
	}
	// E8b: seal the over-threshold body blob at rest (byte cipher). The reader
	// (`readMailMessageText`) and the web-reader proxy both unseal transparently.
	const storageId = await storeSealedBlob(ctx.storage, new TextEncoder().encode(body), contentType);
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
		virusVerdict?: 'clean' | 'infected' | 'skipped';
	}
) {
	// Decode raw MIME and stash in Convex storage.
	const rawBytes = Buffer.from(args.rawBytesBase64, 'base64');
	const rawSize = rawBytes.length;
	// Raw header block decoded once (64KB covers any header section) for both
	// extractions below.
	const rawHeaderBlock = rawBytes.subarray(0, 65536).toString('utf8');
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
	const rawText = rawBytes.toString('utf8');
	const opened = isSealedPgpMime(rawText)
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
	if (!opened.isSealed && (isSignedPgpMime(rawText) || isClearsigned(rawText))) {
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
	// the skip is surfaced via `scannerHealth.warnScanSkipped`). Any verdict
	// the MTA pipeline already set on `args` is preserved (infected wins).
	const inboundVerdict = await scanInboundAttachments(getMtaConfig(), rawBytes);
	const virusVerdict: 'clean' | 'infected' | 'skipped' | undefined =
		args.virusVerdict === 'infected' || inboundVerdict === 'infected'
			? 'infected'
			: (inboundVerdict ?? args.virusVerdict);

	return {
		rawBytes,
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
		virusVerdict,
		inboundEncryptionInfo,
		inboundSignatureInfo,
	};
}

/**
 * Pull attachment leaves out of a delivered message's raw MIME and ingest each
 * into `semanticFiles` (source `email_attachment`). Inline parts (logos,
 * signatures) and oversized parts are skipped; the file-type allowlist is
 * enforced inside `semanticFiles.ingest`, which also drops the staged blob when
 * a part is rejected. Each file carries the source Message-ID as provenance.
 *
 * Captured files are scoped to the sender contact: `fromRaw` (the inbound From
 * header) is resolved to an EXISTING contact by email. When a contact matches,
 * the file is linked to it (`contactIds`), so it surfaces under that contact's
 * Files tab and is scoped to that contact in retrieval. Resolution is
 * find-only — an unknown sender leaves the file org-general (no contact link),
 * we never create a contact for every inbound sender. Thread-linking and
 * agent-output capture are intentionally out of scope here.
 *
 * The number of captured parts is capped at `ATTACHMENT_COMPOSE_LIMITS.maxCount`
 * per message. The inbound webhook is attacker-reachable (anyone can email a
 * provisioned mailbox) and each ingested file schedules a summarization +
 * embedding + knowledge-extraction LLM call, so without a cap a single crafted
 * .eml carrying many small attachment leaves would amplify per-message LLM cost.
 */
export async function captureAttachments(
	ctx: {
		storage: { store: (blob: Blob) => Promise<Id<'_storage'>> };
		runMutation: ActionCtx['runMutation'];
		runQuery: ActionCtx['runQuery'];
	},
	rawBytes: Buffer,
	messageId: string,
	fromRaw: string
): Promise<void> {
	// The extractor wants a binary string (one char per byte) so binary parts survive.
	const binary = rawBytes.toString('latin1');
	const parts = extractAttachments(binary);

	// Scope captured files to the sender's EXISTING contact (find-only). A
	// missing/unresolvable sender leaves the file org-general — we do not create
	// a contact for every inbound message. Resolved once per message, not per part.
	const senderEmail = extractEmail(fromRaw);
	let senderContactIds: Id<'contacts'>[] | undefined;
	if (senderEmail) {
		const contact = await ctx.runQuery(internal.contacts.contacts.getByEmailForTeam, {
			email: senderEmail,
		});
		if (contact) senderContactIds = [contact._id];
	}

	let captured = 0;
	for (const part of parts) {
		// Bound the work per delivered message: each ingested part schedules
		// LLM calls (summarization + embedding + knowledge extraction), and the
		// inbound webhook is attacker-reachable, so a crafted .eml with many
		// small leaves must not amplify cost. Cap on captured (LLM-triggering)
		// parts so inline/oversized skips don't consume the budget.
		if (captured >= ATTACHMENT_COMPOSE_LIMITS.maxCount) break;
		// Skip inline parts (embedded logos / signature images) — they aren't
		// documents the user thinks of as "attachments".
		if (part.disposition === 'inline') continue;
		const size = part.bytes.byteLength;
		if (size === 0 || size > MAX_ATTACHMENT_BYTES) continue;

		const storageId = await ctx.storage.store(
			new Blob([Buffer.from(part.bytes)], { type: part.contentType })
		);
		// `ingest` runs the file-type policy and deletes the blob if rejected.
		await ctx.runMutation(internal.semanticFiles.ingest, {
			storageId,
			filename: part.filename,
			mimeType: part.contentType,
			fileSize: size,
			sourceType: 'email_attachment',
			sourceMessageId: messageId,
			contactIds: senderContactIds,
		});
		captured++;
	}
}
