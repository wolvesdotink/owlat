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
 * MTA delivery webhooks (sent/bounced) flow back to /webhooks/mta and
 * update mailMessages.outbound.state — see mtaWebhook.ts P2 extension.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logError, logInfo } from '../lib/runtimeLog';
import { renderEmailHtml, renderPlainText, renderAmpEmail } from '@owlat/email-renderer';
import type { EditorBlock } from '@owlat/shared/types';
import { getMailSyncConfig, getMtaConfig, scanAttachmentBytes } from './mtaClient';
import type { TransitionOutcome as DraftTransitionOutcome } from './draftLifecycle';
import { buildMessageId, buildRfc822, stripHtml, type DraftRow } from './rfc822';
import { rewriteInlineImageCids, isInlineImageReferenced } from '@owlat/shared/inlineImages';

/**
 * Resolve the final HTML + plain-text (+ optional AMP) bodies for an outbound
 * draft.
 *
 *   - composerMode='full': bodyBlocks holds the block document built by
 *     the @owlat/email-builder; we render it through the email-renderer
 *     pipeline directly. Block-designed bodies also get an AMP4Email
 *     rendering so interactive blocks (accordion, carousel) ship as a
 *     `text/x-amp-html` alternative for AMP-capable clients.
 *   - composerMode='simple' (or unset): bodyHtml holds rich-text HTML
 *     produced by our in-house PostboxBasicEditor. We wrap it in a
 *     synthetic text block so it inherits the same boilerplate, CSS
 *     inlining, dark-mode handling, etc. No AMP variant — the simple
 *     editor has no interactive blocks.
 */
function renderDraftBodies(draft: DraftRow): { html: string; text: string; amp?: string } {
	const wantsFull =
		draft.composerMode === 'full' ||
		(!draft.composerMode && draft.bodyBlocks && draft.bodyBlocks !== '[]');

	if (wantsFull && draft.bodyBlocks) {
		try {
			const blocks = JSON.parse(draft.bodyBlocks) as EditorBlock[];
			if (blocks.length > 0) {
				const html = renderEmailHtml(blocks);
				const text = draft.bodyText ?? renderPlainText(blocks);
				// Only attach an AMP part when the design actually uses an
				// interactive block — otherwise the AMP body is byte-for-byte
				// equivalent to the static fallback and just inflates the message.
				const amp = blocks.some((b) => b.type === 'accordion' || b.type === 'carousel')
					? renderAmpEmail(blocks, { title: draft.subject })
					: undefined;
				return { html, text, amp };
			}
		} catch (err) {
			logError('[Outbound] Failed to parse block-based body, falling back to bodyHtml:', err);
		}
	}

	// Simple mode (or empty designer): wrap bodyHtml in a single text block.
	const wrapped: EditorBlock = {
		id: 'postbox-body',
		type: 'text',
		content: { html: draft.bodyHtml || '' },
	} as unknown as EditorBlock;
	const html = renderEmailHtml([wrapped]);
	const text = draft.bodyText ?? renderPlainText([wrapped]);
	return { html, text };
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

interface ExternalSendResult {
	recipients?: Array<{ address: string; status: 'sent' | 'bounced'; error?: string }>;
}

/**
 * Dispatch a Sent-folder message through the user's external SMTP via the
 * mail-sync worker. Unlike the per-recipient MTA path, this is a SINGLE POST —
 * the external provider fans out — and SMTP is synchronous, so we map the
 * worker's per-recipient result straight onto the postbox outbound lifecycle
 * (no webhook). The worker fetches the raw .eml from `rawEmlUrl` and APPENDs the
 * sent copy to the remote Sent folder. Per ADR-0012.
 */
async function dispatchViaExternalWorker(
	ctx: ActionCtx,
	params: {
		externalAccountId: Id<'externalMailAccounts'>;
		mailMessageId: Id<'mailMessages'>;
		fromAddress: string;
		recipients: string[];
		rawStorageId: Id<'_storage'>;
		rfc822MessageId: string;
	}
): Promise<void> {
	const transitionAll = async (
		input:
			| { to: 'sent'; at: number }
			| { to: 'bounced'; at: number; bounceMessage?: string }
			| { to: 'failed'; at: number; errorMessage: string; errorCode?: string }
	) => {
		for (let i = 0; i < params.recipients.length; i++) {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId: params.mailMessageId,
				recipientIdx: i,
				input,
			});
		}
	};

	const mailSync = getMailSyncConfig();
	if (!mailSync) {
		// Mis-provisioned external-mail install: the mail.external feature is on but
		// the worker URL/key never reached the Convex runtime. Surface a real
		// delivery failure on every recipient instead of silently leaving the
		// message stuck in `queued` forever (the user sees nothing otherwise).
		logError(
			'[Outbound] MAIL_SYNC_API_URL/MAIL_SYNC_API_KEY not set — external message could not be dispatched. Enable the mail.external profile so setup pushes MAIL_SYNC_API_URL + MAIL_SYNC_API_KEY into the Convex runtime.'
		);
		await transitionAll({
			to: 'failed',
			at: Date.now(),
			errorMessage:
				'External mail worker is not configured (MAIL_SYNC_API_URL / MAIL_SYNC_API_KEY missing).',
			errorCode: 'EXTERNAL_NOT_CONFIGURED',
		});
		return;
	}
	const rawEmlUrl = await ctx.storage.getUrl(params.rawStorageId);
	if (!rawEmlUrl) {
		logError(`[Outbound] Missing raw .eml for external send of ${params.mailMessageId}`);
		await transitionAll({
			to: 'failed',
			at: Date.now(),
			errorMessage: 'Internal error: raw message body was not available for dispatch.',
			errorCode: 'EXTERNAL_RAW_EML_MISSING',
		});
		return;
	}

	let result: ExternalSendResult;
	try {
		const res = await fetch(`${mailSync.baseUrl}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mailSync.apiKey}` },
			body: JSON.stringify({
				externalAccountId: params.externalAccountId,
				messageId: params.rfc822MessageId,
				from: params.fromAddress,
				recipients: params.recipients,
				rawEmlUrl,
			}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			logError(`[Outbound] mail-sync /send failed: ${res.status} ${body}`);
			await transitionAll({
				to: 'failed',
				at: Date.now(),
				errorMessage: `mail-sync /send ${res.status}: ${body.slice(0, 200)}`,
				errorCode: 'EXTERNAL_SMTP_HTTP',
			});
			return;
		}
		result = (await res.json()) as ExternalSendResult;
	} catch (err) {
		logError('[Outbound] mail-sync /send error:', err);
		await transitionAll({
			to: 'failed',
			at: Date.now(),
			errorMessage: err instanceof Error ? err.message : String(err),
			errorCode: 'EXTERNAL_SMTP_NETWORK',
		});
		return;
	}

	const perRecipient = result.recipients ?? [];
	for (let i = 0; i < params.recipients.length; i++) {
		const addr = params.recipients[i]!;
		const r = perRecipient.find((x) => x.address.toLowerCase() === addr.toLowerCase());
		// A 2xx response means SMTP accepted the message; a recipient explicitly
		// flagged 'bounced' is a per-RCPT rejection. Missing entries default to
		// sent (accepted by the relay).
		if (r && r.status === 'bounced') {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId: params.mailMessageId,
				recipientIdx: i,
				input: {
					to: 'bounced',
					at: Date.now(),
					bounceMessage: r.error ?? 'Rejected by SMTP server',
				},
			});
		} else {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId: params.mailMessageId,
				recipientIdx: i,
				input: { to: 'sent', at: Date.now() },
			});
		}
	}
}

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
		// Inline body images: rewrite each `<img data-inline-cid="X">` the Simple
		// composer embedded to a `cid:X` reference (the editor kept an ephemeral
		// blob/preview URL) and learn which content-IDs the body still references.
		// This runs BEFORE rendering so the wrapped body carries the final `cid:`
		// srcs, and BEFORE buffering attachments so an inline part whose image the
		// user deleted from the body is pruned rather than shipped.
		const { html: inlinedHtml, referencedCids } = rewriteInlineImageCids(draft.bodyHtml ?? '');
		draft.bodyHtml = inlinedHtml;

		const attachmentBuffers: Array<{
			filename: string;
			contentType: string;
			isInline: boolean;
			contentId?: string;
			data: Buffer;
		}> = [];
		try {
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

				attachmentBuffers.push({
					filename: att.filename,
					contentType: att.contentType,
					isInline: att.isInline,
					contentId: att.contentId,
					data: buf,
				});
			}
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

		// Render the final HTML + plaintext bodies through @owlat/email-renderer.
		// `draft` is mutated in place — both simple-mode (Tiptap) and full-mode
		// (block-based EmailBuilder) flow through the same pipeline.
		const rendered = renderDraftBodies(draft);
		draft.bodyHtml = rendered.html;
		draft.bodyText = rendered.text;
		draft.bodyAmp = rendered.amp;

		const { raw, size } = buildRfc822(
			draft,
			attachmentBuffers,
			rfc822MessageId,
			inReplyToHeaderValue,
			referencesHeaderValue
		);

		// Store the raw .eml in Convex storage. Convert to Uint8Array first
		// because Blob's BlobPart type doesn't accept the Node Buffer<Shared|
		// ArrayBuffer> union directly under newer @types/node.
		const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
		const rawStorageId = await ctx.storage.store(
			// `BlobPart` typings reject Uint8Array<ArrayBufferLike> under newer
			// @types/node; the runtime accepts it. Cast through unknown.
			new Blob([rawBytes as unknown as BlobPart], { type: 'message/rfc822' })
		);

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
						rawSize: size,
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

		// POST to MTA /send for each recipient. We prefix the MTA messageId with
		// "pb-<mailMessagesId>-" so the bounce/sent webhook can look the row back up.
		const mta = getMtaConfig();
		const recipients = [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses].filter(
			(r, i, arr) => arr.indexOf(r) === i
		);

		const dkimDomain = draft.fromAddress.split('@')[1] ?? 'localhost';

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
		const transport = await ctx.runQuery(internal.mail.externalAccounts.resolveOutboundTransport, {
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

		if (mta) {
			for (let i = 0; i < recipients.length; i++) {
				const to = recipients[i];
				// Prefix lets mtaWebhook parse the Convex mailMessages id from
				// `payload.messageId` on sent/bounced events. Matches the
				// recipients[idx].mtaJobId written by the lifecycle's
				// insert_mail_message effect.
				const mtaMessageId = `pb-${mailMessageId}-${i}`;
				try {
					const res = await fetch(`${mta.baseUrl}/send`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${mta.apiKey}`,
						},
						body: JSON.stringify({
							messageId: mtaMessageId,
							from: draft.fromAddress,
							to,
							subject: draft.subject || '(no subject)',
							html: draft.bodyHtml || stripHtml(draft.bodyHtml ?? '') || ' ',
							text: draft.bodyText,
							...(draft.bodyAmp ? { amp: draft.bodyAmp } : {}),
							headers: {
								'Message-ID': rfc822MessageId,
								...(inReplyToHeaderValue ? { 'In-Reply-To': inReplyToHeaderValue } : {}),
								...(referencesHeaderValue ? { References: referencesHeaderValue } : {}),
							},
							ipPool: 'transactional',
							organizationId: 'postbox',
							dkimDomain,
							allowedFromAddresses,
						}),
					});
					if (!res.ok) {
						const body = await res.text().catch(() => '');
						logError(`[Outbound] MTA /send failed for ${to}: ${res.status} ${body}`);
						// Per-recipient synchronous bounce — record it now rather
						// than waiting forever in `queued`. Per ADR-0012.
						await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
							mailMessageId,
							recipientIdx: i,
							input: {
								to: 'bounced',
								at: Date.now(),
								bounceMessage: `MTA POST ${res.status}: ${body.slice(0, 200)}`,
							},
						});
					}
				} catch (err) {
					logError(`[Outbound] MTA /send error for ${to}:`, err);
					// Per-recipient pre-MTA error (network failure, DNS, etc.).
					// Recipient resolves to `failed` instead of staying `queued`.
					await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
						mailMessageId,
						recipientIdx: i,
						input: {
							to: 'failed',
							at: Date.now(),
							errorMessage: err instanceof Error ? err.message : String(err),
							errorCode: 'MTA_POST_NETWORK',
						},
					});
				}
			}
		} else {
			logError(
				'[Outbound] MTA_API_URL/MTA_API_KEY not set — message saved to Sent but not dispatched'
			);
		}
	},
});

// `getMessage` lives in mailOutboundQueries.ts so it can run in the v8
// isolate (Convex requires query definitions to be non-`'use node'`).
// The send-success cascade, the per-revert reverts, and the recipient/
// row-delete fan-out moved to the Mail draft lifecycle (module) — see
// docs/adr/0028-mail-draft-lifecycle-module.md.
