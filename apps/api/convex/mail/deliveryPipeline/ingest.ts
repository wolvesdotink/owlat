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
import {
	ATTACHMENT_COMPOSE_LIMITS,
	MAX_AI_INGEST_ATTACHMENT_BYTES,
	MAX_ATTACHMENT_BYTES,
} from '@owlat/shared/attachments';
import { isFileTypeAccepted } from '@owlat/email-scanner';
import { logError, logWarn } from '../../lib/runtimeLog';
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
		virusVerdict?: 'clean' | 'infected' | 'skipped';
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
	// the skip is surfaced via `scannerHealth.warnScanSkipped`). Any verdict
	// the MTA pipeline already set on `args` is preserved (infected wins).
	const inboundVerdict = await scanInboundAttachments(getMtaConfig(), rawBinary);
	const virusVerdict: 'clean' | 'infected' | 'skipped' | undefined =
		args.virusVerdict === 'infected' || inboundVerdict === 'infected'
			? 'infected'
			: (inboundVerdict ?? args.virusVerdict);

	return {
		rawBinary,
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
 * What one `captureAttachments` call did, so the caller can say it.
 *
 * A capture that indexed nothing is not the same as one that indexed
 * everything, and before this the difference was a log line: the attachment
 * still listed and still downloaded, but the agent never saw it and no reader
 * could tell. `skippedReason` is what the thread view renders.
 *
 * It is reported even when OTHER parts of the same message WERE indexed —
 * "some of these the assistant has not read" is the true sentence, and there is
 * no per-part marker on the row to say which.
 */
export type AttachmentCaptureOutcome = {
	/** How many parts reached `semanticFiles.ingest` (and therefore a model). */
	indexed: number;
	/**
	 * Why a part that arrived was not indexed:
	 *   · `budget` — the per-sender/global AI-ingest budget refused the batch;
	 *   · `too_large` — over `MAX_AI_INGEST_ATTACHMENT_BYTES`;
	 *   · `unsupported_type` — the file-type allowlist refused it.
	 */
	skippedReason?: 'budget' | 'too_large' | 'unsupported_type';
};

/** One `captureAttachments` argument bag — see the doc comment on the function. */
export type CaptureAttachmentsInput = {
	/** The whole received message as a byte-preserving binary string. */
	rawBinary: string;
	/** The source Message-ID, recorded on every captured file as provenance. */
	messageId: string;
	/** The raw `From:` header, resolved to a contact for scoping. */
	from: string;
	/** Which inbound route is capturing; decides retention reach. */
	captureSource: 'team_inbox' | 'mailbox';
	/**
	 * The message's DMARC verdict as the MTA computed it. `'fail'` suppresses
	 * contact scoping — see the note above. Absent on an older MTA, which reads
	 * as "no verdict", not as a failure.
	 */
	dmarcResult?: string;
};

/**
 * Pull attachment leaves out of a delivered message's raw MIME and ingest each
 * into `semanticFiles` (source `email_attachment`). Inline parts (logos,
 * signatures), oversized parts and types the allowlist refuses are skipped —
 * and the skip comes BACK to the caller, because a file nobody read that looks
 * exactly like one that was read is the defect this returns an outcome for.
 * Each file carries the source Message-ID as provenance.
 *
 * Captured files are scoped to the sender contact: `input.from` (the inbound
 * From header) is resolved to an EXISTING contact by email. When a contact
 * matches,
 * the file is linked to it (`contactIds`), so it surfaces under that contact's
 * Files tab and is scoped to that contact in retrieval. Resolution is
 * find-only — an unknown sender leaves the file org-general (no contact link),
 * we never create a contact for every inbound sender. Thread-linking and
 * agent-output capture are intentionally out of scope here.
 *
 * SCOPING IS NOT DONE ON AN UNAUTHENTICATED `From:`. A `From:` header is free
 * text: anyone can send as `ceo@customer.example`. DMARC is the check that
 * binds it to a domain that authorized the message, so a message whose DMARC
 * verdict is a FAIL is captured ORG-GENERAL — the bytes still arrive, they are
 * just not filed under the contact the sender claimed to be, and the agent
 * drafting a reply to the real contact does not retrieve them as that contact's
 * document. Anything else (`pass`, `none`, no verdict at all from an older MTA)
 * scopes as before.
 *
 * SHARED BY BOTH INBOUND ROUTES — the personal mailbox and the team inbox — so
 * the two cannot enforce different attachment policy. `captureSource` is how
 * the row remembers which one it came from, and the ONLY thing that separates
 * them afterwards: the inbound retention sweep releases `'team_inbox'` blobs
 * and never touches `'mailbox'` ones. The ceilings, in order:
 *
 *   · `disposition === 'inline'` and empty parts are not attachments;
 *   · over `MAX_ATTACHMENT_BYTES` (25 MiB) is not stored at all;
 *   · over `MAX_AI_INGEST_ATTACHMENT_BYTES` is not INDEXED — it still delivers,
 *     still lists, and is still downloadable out of the raw `.eml`;
 *   · a type the file-type allowlist refuses is not indexed either, and is
 *     refused HERE, before a blob is staged and before the budget is charged;
 *   · at most `ATTACHMENT_COMPOSE_LIMITS.maxCount` (10) parts per message.
 *
 * Then the whole batch is charged against the per-sender and global AI-ingest
 * budget. Tripping it skips `semanticFiles.ingest` — nothing reaches a model —
 * while the bytes, the row and the metadata all survive, and the outcome comes
 * back so the caller can record it.
 */
export async function captureAttachments(
	ctx: {
		storage: { store: (blob: Blob) => Promise<Id<'_storage'>> };
		runMutation: ActionCtx['runMutation'];
		runQuery: ActionCtx['runQuery'];
	},
	input: CaptureAttachmentsInput
): Promise<AttachmentCaptureOutcome> {
	// Decide the whole batch up front: the budget is charged once for what will
	// actually be ingested, so a message of inline logos costs nothing.
	const parts = extractAttachments(input.rawBinary).filter((part) => {
		// Inline parts (embedded logos / signature images) aren't documents the
		// user thinks of as "attachments".
		if (part.disposition === 'inline') return false;
		const size = part.bytes.byteLength;
		return size > 0 && size <= MAX_ATTACHMENT_BYTES;
	});

	// Over the AI ceiling the bytes still arrive, they are just not fed to a
	// model. See MAX_AI_INGEST_ATTACHMENT_BYTES.
	const withinCeiling = parts.filter(
		(part) => part.bytes.byteLength <= MAX_AI_INGEST_ATTACHMENT_BYTES
	);
	// The file-type allowlist decided HERE rather than only inside
	// `semanticFiles.ingest`: that gate runs after the blob is staged and after
	// the AI budget is charged, so ten `.exe` leaves used to cost a sender — and
	// the instance — ten tokens each while scheduling no model work at all.
	const ingestible = withinCeiling.filter((part) =>
		isFileTypeAccepted(part.filename, part.contentType)
	);
	const skippedReason: AttachmentCaptureOutcome['skippedReason'] | undefined =
		withinCeiling.length < parts.length
			? 'too_large'
			: ingestible.length < withinCeiling.length
				? 'unsupported_type'
				: undefined;

	// Bound the work per delivered message: each ingested part schedules LLM
	// calls, and the inbound webhook is attacker-reachable, so a crafted .eml
	// with many small leaves must not amplify cost.
	const eligible = ingestible.slice(0, ATTACHMENT_COMPOSE_LIMITS.maxCount);
	if (eligible.length === 0) return { indexed: 0, skippedReason };

	// Scope captured files to the sender's EXISTING contact (find-only). A
	// missing/unresolvable sender — or one whose `From:` DMARC did not hold up —
	// leaves the file org-general. Resolved once per message, not per part.
	const senderEmail = extractEmail(input.from);
	const isSenderSpoofable = input.dmarcResult === 'fail';
	let senderContactIds: Id<'contacts'>[] | undefined;
	// Resolved HERE rather than taken from the caller even where the caller has
	// just upserted the contact: `getByEmailForTeam` is the lookup that ignores
	// GDPR gravestones, and an id handed in from outside would file an
	// attachment under an erased contact.
	if (senderEmail && !isSenderSpoofable) {
		const contact = await ctx.runQuery(internal.contacts.contacts.getByEmailForTeam, {
			email: senderEmail,
		});
		if (contact) senderContactIds = [contact._id];
	}

	// Prefer the resolved contact id: it survives a sender rewriting their
	// display name, and it is the key the agent-pipeline gate already uses. The
	// already-lowercased address is the fallback for a sender with no contact (or
	// one erased under GDPR, which `getByEmailForTeam` reads as absent).
	// `||`, not `??`: `extractEmail` returns `''` for a From header with nothing
	// address-shaped in it, and an empty bucket key is not a key.
	const senderKey = senderContactIds?.[0] ?? (senderEmail || 'unknown');
	const { ok } = await ctx.runMutation(
		internal.knowledge.attachmentIngestBudget.consumeAttachmentIngestBudget,
		{
			senderKey,
			count: eligible.length,
		}
	);
	if (!ok) {
		// The bytes are NOT dropped: the message row, its attachment metadata and
		// the sealed raw `.eml` all exist, so the reader's download still works.
		// Only the indexing — and therefore the model spend — is skipped. A WARN,
		// not an error: this is the budget doing its job, on a route where a busy
		// inbox will trip it routinely.
		logWarn('[Attachment capture] AI ingest budget exhausted — bytes stored, indexing skipped', {
			senderKey,
			messageId: input.messageId,
			count: eligible.length,
		});
		return { indexed: 0, skippedReason: 'budget' };
	}

	let indexed = 0;
	for (const part of eligible) {
		const storageId = await ctx.storage.store(new Blob([part.bytes], { type: part.contentType }));
		// `ingest` re-runs the same file-type policy as the filter above and
		// deletes the blob if it disagrees.
		const fileId = await ctx.runMutation(internal.semanticFiles.ingest, {
			storageId,
			filename: part.filename,
			mimeType: part.contentType,
			fileSize: part.bytes.byteLength,
			sourceType: 'email_attachment',
			captureSource: input.captureSource,
			sourceMessageId: input.messageId,
			contactIds: senderContactIds,
		});
		if (fileId) indexed++;
	}
	// A part the pre-filter accepted and `ingest` still refused is a policy
	// disagreement, not a silent success: report it as the type skip it is.
	if (indexed < eligible.length && !skippedReason) {
		return { indexed, skippedReason: 'unsupported_type' };
	}
	return { indexed, skippedReason };
}
