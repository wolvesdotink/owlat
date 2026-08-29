'use node';

/**
 * Outbound personal mail — the BUILD half.
 *
 * Everything that turns a `mailDrafts` row into wire bytes: inline-image
 * rewriting + attachment buffering (with the ClamAV gate), threading headers,
 * body rendering, the RFC 5322 assembly, and the Sealed Mail (E3) decision +
 * PGP/MIME sealing. Nothing here talks to a transport — that is
 * `./dispatch.ts`; `../outbound.ts` orchestrates the two.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { logError } from '../../lib/runtimeLog';
import { renderDraftBodies } from '@owlat/email-renderer';
import { getMtaConfig, scanAttachmentBytes } from '../mtaClient';
import { buildMessageId, buildRfc822, type DraftRow } from '../rfc822';
import { rewriteInlineImageCids, isInlineImageReferenced } from '@owlat/shared/inlineImages';
import { decideSeal, type OutboundEncryptionInfo } from '../sealPolicy';
import { sealMime, type SealedMime } from '../../e2ee/seal';
import { openPrivateKey } from '../../e2ee/sealing';

export interface DraftAttachmentBuffer {
	filename: string;
	contentType: string;
	isInline: boolean;
	contentId?: string;
	data: Buffer;
}

/**
 * ClamAV scan via MTA `/scan/attachment` endpoint. Throws
 * `ScannedMalwareError` on confirmed malware, returns silently otherwise.
 * Fail-open on scanner outage (the campaign mail path does the same).
 *
 * Postbox dispatch was previously the only outbound path that bypassed
 * the scanner entirely. This wires it in to match emailWorker.ts.
 */
export class ScannedMalwareError extends Error {
	constructor(
		public readonly filename: string,
		public readonly reason: string
	) {
		super(`Attachment "${filename}" blocked by malware scan: ${reason}`);
		this.name = 'ScannedMalwareError';
	}
}

async function scanAttachment(filename: string, data: Buffer): Promise<void> {
	// Shared client owns the POST + fail-open (not-configured / scanner-down /
	// network error all resolve to 'skipped' and are surfaced via
	// warnScanSkipped). This path's POLICY: a confirmed-infected verdict throws
	// ScannedMalwareError so dispatch aborts; everything else proceeds.
	const verdict = await scanAttachmentBytes(getMtaConfig(), filename, data);
	if (verdict.kind === 'infected') {
		throw new ScannedMalwareError(filename, verdict.reason);
	}
}

/**
 * Rewrite the draft's inline images and buffer its attachments.
 *
 * Inline body images: rewrite each `<img data-inline-cid="X">` the Simple
 * composer embedded to a `cid:X` reference (the editor kept an ephemeral
 * blob/preview URL) and learn which content-IDs the body still references.
 * This runs BEFORE rendering so the wrapped body carries the final `cid:`
 * srcs, and BEFORE buffering attachments so an inline part whose image the
 * user deleted from the body is pruned rather than shipped.
 *
 * Every non-inline part is scanned through MTA's ClamAV endpoint before it is
 * allowed to ship; a confirmed verdict throws {@link ScannedMalwareError} so
 * the caller can abort the dispatch and revert the draft.
 */
export async function bufferDraftAttachments(
	ctx: ActionCtx,
	draft: DraftRow
): Promise<{ inlinedHtml: string; attachments: DraftAttachmentBuffer[] }> {
	const { html: inlinedHtml, referencedCids } = rewriteInlineImageCids(draft.bodyHtml ?? '');

	const attachments: DraftAttachmentBuffer[] = [];
	for (const att of draft.attachments) {
		// Drop inline parts the body no longer references (image deleted).
		if (att.isInline && !isInlineImageReferenced(referencedCids, att.contentId)) {
			continue;
		}
		const blob = await ctx.storage.get(att.storageId);
		if (!blob) continue;
		const buf = Buffer.from(await blob.arrayBuffer());

		// Throws ScannedMalwareError on positive verdict. Anything else
		// (scanner missing, network blip, parse error) returns silently.
		await scanAttachment(att.filename, buf);

		attachments.push({
			filename: att.filename,
			contentType: att.contentType,
			isInline: att.isInline,
			contentId: att.contentId,
			data: buf,
		});
	}
	return { inlinedHtml, attachments };
}

/**
 * Assemble the RFC 5322 message: mint the Message-ID, resolve the
 * In-Reply-To/References headers from the message being replied to, render the
 * final bodies through @owlat/email-renderer, and build the MIME.
 *
 * `draft` is mutated in place with the rendered bodies — both simple-mode
 * (Tiptap) and full-mode (block-based EmailBuilder) flow through the same
 * pipeline, and the caller passes the rendered bodies on to the lifecycle.
 */
export async function buildOutboundMime(
	ctx: ActionCtx,
	draft: DraftRow,
	attachments: DraftAttachmentBuffer[]
): Promise<{
	raw: Buffer;
	rfc822MessageId: string;
	inReplyToHeaderValue?: string;
	referencesHeaderValue?: string;
}> {
	const domain = draft.fromAddress.split('@')[1] ?? 'localhost';
	const rfc822MessageId = buildMessageId(domain);

	// Threading headers
	let inReplyToHeaderValue: string | undefined;
	let referencesHeaderValue: string | undefined;
	if (draft.inReplyToMessageId) {
		const original = await ctx.runQuery(internal.mail.outboundQueries.getMessage, {
			messageId: draft.inReplyToMessageId,
		});
		if (original) {
			inReplyToHeaderValue = `<${original.rfc822MessageId}>`;
			const refsList = [...(original.references ?? []), original.rfc822MessageId];
			referencesHeaderValue = refsList.map((r) => `<${r}>`).join(' ');
		}
	}

	// Same derivation the composer's "Preview as sent" shows (idea 14): one
	// implementation in @owlat/email-renderer, so the preview cannot drift from
	// what actually goes on the wire.
	const rendered = renderDraftBodies(draft, {
		onBlockParseError: (err) =>
			logError('[Outbound] Failed to parse block-based body, falling back to bodyHtml:', err),
	});
	draft.bodyHtml = rendered.html;
	draft.bodyText = rendered.text;
	draft.bodyAmp = rendered.amp;

	const { raw } = buildRfc822(
		draft,
		attachments,
		rfc822MessageId,
		inReplyToHeaderValue,
		referencesHeaderValue
	);

	return { raw, rfc822MessageId, inReplyToHeaderValue, referencesHeaderValue };
}

/**
 * Sealed Mail (E3): seal the built message into signed+encrypted PGP/MIME when
 * the org policy allows AND EVERY recipient has a usable pinned key (locked
 * decisions D1/D2/D4). One keyless recipient ⇒ plaintext with the reason
 * recorded — NEVER a mixed send (D2). The agent-reply path flows through this
 * exact code (agent drafts dispatch via `dispatchDraft` too), so it seals
 * identically with no special-casing. When sealed, the stored `.eml` and the
 * on-wire body are ciphertext; the real subject travels inside and the outer
 * subject is the literal placeholder "..." (D4).
 *
 * `isFlagEnabled` is returned so the caller can keep a flag-off deployment
 * byte-identical: it neither stamps `encryptionInfo` on the row nor enforces
 * the unsealed-send consent gate.
 */
export async function sealOutboundMessage(
	ctx: ActionCtx,
	draft: DraftRow,
	raw: Buffer
): Promise<{
	storedBytes: Buffer;
	sealed: SealedMime | null;
	encryptionInfo: OutboundEncryptionInfo;
	isFlagEnabled: boolean;
}> {
	const sealRecipients = [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses];
	let sealInputs = await ctx.runQuery(internal.mail.outboundQueries.getOutboundSealInputs, {
		fromAddress: draft.fromAddress,
		recipients: sealRecipients,
	});
	// First contact must get the same chance to seal as a previously-seen peer.
	// Refresh only absent/expired cache rows, only when auto-sealing could
	// actually proceed. Discovery is fail-soft and cache-aware; one peer's
	// network failure becomes an honest plaintext decision, never a stuck send.
	if (
		sealInputs.flagEnabled &&
		sealInputs.policy === 'auto' &&
		sealInputs.hasSigningKey &&
		sealInputs.discoveryAddresses.length > 0
	) {
		await Promise.all(
			sealInputs.discoveryAddresses.map((address: string) =>
				ctx.runAction(internal.e2ee.discovery.discoverRecipientKey, { address })
			)
		);
		sealInputs = await ctx.runQuery(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: draft.fromAddress,
			recipients: sealRecipients,
		});
	}
	const sealDecision = decideSeal(sealInputs);

	let storedBytes: Buffer = raw;
	let sealed: SealedMime | null = null;
	let encryptionInfo: OutboundEncryptionInfo;
	if (sealDecision.seal) {
		// Open the sender's private signing key from the vault (Node plane only).
		const signingRow = await ctx.runQuery(internal.e2ee.keys.getAddressKeyInternal, {
			address: draft.fromAddress,
		});
		if (!signingRow) {
			// The key vanished between the readiness check and here — fail SOFT to
			// plaintext with the reason recorded rather than blocking the send.
			encryptionInfo = { isSealed: false, reason: 'no_signing_key' };
		} else {
			const signingKeyArmored = openPrivateKey(signingRow.sealedPrivateKey);
			sealed = await sealMime(raw.toString('utf-8'), {
				recipientPublicKeysArmored: sealDecision.recipientPublicKeysArmored,
				signingKeyArmored,
				protectSubject: true,
			});
			storedBytes = Buffer.from(sealed.mime, 'utf-8');
			encryptionInfo = {
				isSealed: true,
				algorithm: sealed.encryptionInfo.algorithm,
				recipientFingerprints: sealed.encryptionInfo.recipientFingerprints,
				signingFingerprint: sealed.encryptionInfo.signingFingerprint,
			};
		}
	} else {
		encryptionInfo = { isSealed: false, reason: sealDecision.reason };
	}

	return { storedBytes, sealed, encryptionInfo, isFlagEnabled: sealInputs.flagEnabled };
}
