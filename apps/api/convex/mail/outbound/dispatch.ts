'use node';

/**
 * Outbound personal mail — the DISPATCH half.
 *
 * Two transports for an already-built, already-stored message, branched on the
 * sending mailbox's kind by `../outbound.ts`:
 *
 *   - {@link dispatchViaMta} — hosted mailboxes, one POST per recipient to the
 *     MTA `/send/postbox` intake. Delivery outcomes arrive later by webhook;
 *     only synchronous refusals are recorded here.
 *   - {@link dispatchViaExternalWorker} — external mailboxes, a SINGLE POST to
 *     the mail-sync worker, which relays through the user's own SMTP.
 *
 * Both drive `mail.postboxOutboundLifecycle.transition` for per-recipient
 * outcomes; neither builds or seals anything (that is `./build.ts`).
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { logError } from '../../lib/runtimeLog';
import { sealedBlobUrl } from '../../lib/sealedBlob';
import { getMailSyncConfig } from '../mtaClient';
import { stripHtml, type DraftRow } from '../rfc822';
import type { MtaSendRequest } from '@owlat/mta-protocol/send';
import type { SealedMime } from '../../e2ee/seal';

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
export async function dispatchViaExternalWorker(
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
	// E8b: the stored `.eml` is sealed at rest, so hand the worker a
	// decrypt-serving proxy URL — it fetches back the PLAINTEXT bytes to APPEND
	// the sent copy remotely, exactly as it did with the bare storage URL.
	const rawEmlUrl = await sealedBlobUrl(ctx.storage, params.rawStorageId, 'message/rfc822');
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

/**
 * POST to MTA /send for each recipient. We prefix the MTA messageId with
 * "pb-<mailMessagesId>-" so the bounce/sent webhook can look the row back up.
 *
 * When sealing applied, the complete PGP/MIME bytes pass through the MTA
 * unchanged; the placeholder Subject and ciphertext body are already inside
 * that envelope. When not sealed, the classic structured fields ride exactly
 * as before. (The external worker fetches the same stored `.eml` directly.)
 */
export async function dispatchViaMta(
	ctx: ActionCtx,
	params: {
		draft: DraftRow;
		sealed: SealedMime | null;
		mailMessageId: Id<'mailMessages'>;
		recipients: string[];
		rfc822MessageId: string;
		inReplyToHeaderValue?: string;
		referencesHeaderValue?: string;
		allowedFromAddresses: string[];
		mta: { baseUrl: string; apiKey: string } | null;
	}
): Promise<void> {
	const { draft, sealed, mailMessageId, mta } = params;
	const dkimDomain = draft.fromAddress.split('@')[1] ?? 'localhost';

	const wireContent: Pick<
		MtaSendRequest,
		'subject' | 'html' | 'text' | 'amp' | 'sealedMimeBase64'
	> = sealed
		? {
				subject: sealed.outerSubject,
				html: ' ',
				sealedMimeBase64: Buffer.from(sealed.mime, 'utf-8').toString('base64'),
			}
		: {
				subject: draft.subject || '(no subject)',
				html: draft.bodyHtml || stripHtml(draft.bodyHtml ?? '') || ' ',
				text: draft.bodyText,
				...(draft.bodyAmp ? { amp: draft.bodyAmp } : {}),
			};

	if (!mta) {
		logError(
			'[Outbound] MTA_API_URL/MTA_API_KEY not set — message saved to Sent but not dispatched'
		);
		return;
	}

	for (let i = 0; i < params.recipients.length; i++) {
		const to = params.recipients[i]!;
		// Prefix lets the `pb-` branch of webhooks/dispatcher.ts parse the
		// Convex mailMessages id out of the `payload.messageId` that
		// webhooks/adapters/mta.ts reports on sent/bounced events. Matches the
		// recipients[idx].mtaJobId written by the lifecycle's
		// insert_mail_message effect.
		const mtaMessageId = `pb-${mailMessageId}-${i}`;
		try {
			const res = await fetch(`${mta.baseUrl}/send/postbox`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${mta.apiKey}`,
				},
				// The postbox intake wire, typed against its one declaration (D7).
				// `sealedMimeBase64`, `amp` and `allowedFromAddresses` exist on
				// `MtaSendRequest` for THIS producer and the two in
				// `deliveryHooks.ts` only, so without the annotation they had no
				// compile-time producer at all: renaming one on the MTA side would
				// leave this literal emitting the old key, and the MTA silently
				// dropping the ciphertext / the AMP part / the From allow-list.
				body: JSON.stringify({
					messageId: mtaMessageId,
					from: draft.fromAddress,
					to,
					...wireContent,
					headers: {
						'Message-ID': params.rfc822MessageId,
						...(params.inReplyToHeaderValue ? { 'In-Reply-To': params.inReplyToHeaderValue } : {}),
						...(params.referencesHeaderValue ? { References: params.referencesHeaderValue } : {}),
					},
					ipPool: 'transactional',
					organizationId: 'postbox',
					dkimDomain,
					allowedFromAddresses: params.allowedFromAddresses,
				} satisfies MtaSendRequest),
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
}
