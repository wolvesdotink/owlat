'use node';

/**
 * Send one read receipt (RFC 8098) for a request the user, or their
 * `readReceiptReply` setting, chose to answer (`./readReceipts.ts`).
 *
 * The receipt is a `multipart/report` built whole by
 * `@owlat/mail-message/compose/mdn` and handed to the mailbox's own outbound
 * transport as finished bytes: the hosted MTA's `/send/postbox` intake (which
 * authorizes a disposition-notification report as raw MIME), or the mail-sync
 * worker's `/send` for a connected account, which relays it through the
 * user's SMTP or Microsoft Graph like any other sent message.
 *
 * No Sent copy is kept in Owlat. When the receipt cannot be handed over, the
 * request is reopened so the reader asks again instead of claiming it went
 * out.
 */

import { v } from 'convex/values';
import { buildDispositionNotification } from '@owlat/mail-message/compose/mdn';
import { buildMessageId } from '@owlat/mail-message/compose/messageId';
import { correlationHeader, mintCorrelationId } from '@owlat/shared/correlation';
import { redactEmailAddress } from '@owlat/shared/logRedaction';
import type { MtaSendRequest } from '@owlat/mta-protocol/send';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logEvent } from '../lib/runtimeLog';
import { FETCH_TIMEOUTS, fetchWithTimeout } from '../lib/fetchWithTimeout';
import { sealedBlobUrl, storeSealedBlob } from '../lib/sealedBlob';
import { getMailSyncConfig, getMtaConfig } from './mtaClient';

/** Product token in the receipt's `Reporting-UA` field. */
const REPORTING_UA = 'Owlat';

type Delivery = { ok: true } | { ok: false; error: string };

async function sendViaMta(
	params: { from: string; to: string; subject: string; raw: Buffer; messageId: Id<'mailMessages'> },
	allowedFromAddresses: string[]
): Promise<Delivery> {
	const mta = getMtaConfig();
	if (!mta) return { ok: false, error: 'MTA not configured' };
	const correlationId = mintCorrelationId('mdn');
	const res = await fetchWithTimeout(
		`${mta.baseUrl}/send/postbox`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${mta.apiKey}`,
				...correlationHeader(correlationId, 'mdn'),
			},
			body: JSON.stringify({
				// `pb-` routes the MTA's delivery webhooks to Postbox, where an id that
				// names no Sent row is ignored, as for the vacation reply.
				messageId: `pb-mdn-${params.messageId}-${Date.now()}`,
				from: params.from,
				to: params.to,
				subject: params.subject,
				html: ' ',
				sealedMimeBase64: params.raw.toString('base64'),
				ipPool: 'transactional',
				organizationId: 'postbox',
				dkimDomain: params.from.split('@')[1] ?? 'localhost',
				allowedFromAddresses,
			} satisfies MtaSendRequest),
		},
		FETCH_TIMEOUTS.mtaIntake
	);
	if (res.ok) return { ok: true };
	const body = await res.text().catch(() => '');
	return { ok: false, error: `MTA ${res.status}: ${body.slice(0, 200)}` };
}

async function sendViaExternalWorker(
	ctx: ActionCtx,
	params: { externalAccountId: Id<'externalMailAccounts'>; from: string; to: string; raw: Buffer }
): Promise<Delivery> {
	const mailSync = getMailSyncConfig();
	if (!mailSync) return { ok: false, error: 'mail-sync worker not configured' };
	// The worker fetches the bytes by URL, as for every external send; the blob
	// is only needed until it answered.
	const storageId = await storeSealedBlob(
		ctx.storage,
		new Uint8Array(params.raw.buffer, params.raw.byteOffset, params.raw.byteLength),
		'message/rfc822'
	);
	try {
		const rawEmlUrl = await sealedBlobUrl(ctx.storage, storageId, 'message/rfc822');
		if (!rawEmlUrl) return { ok: false, error: 'receipt bytes not readable' };
		const res = await fetchWithTimeout(
			`${mailSync.baseUrl}/send`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mailSync.apiKey}` },
				body: JSON.stringify({
					externalAccountId: params.externalAccountId,
					from: params.from,
					recipients: [params.to],
					rawEmlUrl,
				}),
			},
			FETCH_TIMEOUTS.externalSend
		);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			return { ok: false, error: `mail-sync ${res.status}: ${body.slice(0, 200)}` };
		}
		return { ok: true };
	} finally {
		await ctx.storage.delete(storageId).catch(() => undefined);
	}
}

export const sendReceipt = internalAction({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const receipt = await ctx.runQuery(internal.mail.readReceipts.loadReceiptToSend, {
			messageId: args.messageId,
		});
		if (!receipt) return;
		const [allowedFromAddresses, transport] = await Promise.all([
			ctx.runQuery(internal.mail.identities.resolveAllowedFromAddresses, {
				mailboxId: receipt.mailboxId,
			}),
			ctx.runQuery(internal.mail.outboundTransport.resolveOutboundTransport, {
				mailboxId: receipt.mailboxId,
			}),
		]);
		const domain = receipt.from.split('@')[1] ?? 'localhost';
		const subject = `Read: ${receipt.originalSubject || '(no subject)'}`;
		const { raw } = buildDispositionNotification({
			from: receipt.from,
			to: receipt.to,
			originalSubject: receipt.originalSubject,
			originalMessageId: receipt.originalMessageId,
			messageId: buildMessageId(domain),
			mode: receipt.isAutomatic ? 'automatic' : 'manual',
			reportingUa: REPORTING_UA,
		});

		let delivery: Delivery;
		try {
			delivery =
				transport.kind === 'external'
					? await sendViaExternalWorker(ctx, {
							externalAccountId: transport.externalAccountId,
							from: receipt.from,
							to: receipt.to,
							raw,
						})
					: await sendViaMta(
							{ from: receipt.from, to: receipt.to, subject, raw, messageId: args.messageId },
							allowedFromAddresses
						);
		} catch (err) {
			delivery = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}

		const detail = { to: redactEmailAddress(receipt.to), transport: transport.kind };
		if (delivery.ok) {
			logEvent('postbox.read_receipt.sent', { outcome: 'sent', detail });
			return;
		}
		logEvent(
			'postbox.read_receipt.failed',
			{ outcome: 'failed', detail: { ...detail, error: delivery.error } },
			'error'
		);
		await ctx.runMutation(internal.mail.readReceipts.reopenUnsentReceipt, {
			messageId: args.messageId,
		});
	},
});
