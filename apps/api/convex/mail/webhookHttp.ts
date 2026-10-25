/**
 * Personal-Mail (Postbox) Webhook Handler
 *
 * Receives inbound delivery events from owlat-mta for per-user mailboxes.
 * Distinct from /webhooks/mta which handles bounces, complaints, IP
 * reputation events, and from /webhooks/mta-inbound which handles the
 * AI-shared inbox flow.
 *
 * Endpoint: POST /webhooks/mta-mailbox
 * Events: 'inbound.mailbox.received'
 *
 * The preamble every raw-body MTA route shares — per-source rate limit, secret
 * lookup, the `verifyMtaSignedRequest` HMAC + 5-minute staleness window, the
 * unbounded body read and the bounded digest-not-a-copy audit row — lives in
 * `webhooks/adapters/mtaRawRoute.ts`, so this route and the team-inbox one
 * cannot drift on any of it. What stays here is the payload shape, the event
 * check, the envelope fields worth auditing and the postbox dispatch target
 * (mail.delivery.ingestFromWebhook), which is distinct from the customer-inbound
 * dispatcher — hence a standalone handler rather than a runInboundPipeline
 * adapter.
 */

import { v } from 'convex/values';
import { isRecord } from '@owlat/shared';
import { decodeJsonValue } from '@owlat/worker-protocol/decodeJson';
import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError } from '../lib/runtimeLog';
import { jsonResponse } from '../webhooks/inboundHttp';
import {
	isWorkspaceBeingDeleted,
	isWorkspaceDeletionRefusal,
	workspaceDeletionAck,
} from '../webhooks/workspaceDeletionAck';
import {
	base64ByteLength,
	clampAuditField,
	readVerifiedMtaBody,
	storeRawRouteAudit,
	unsupportedEventResponse,
} from '../webhooks/adapters/mtaRawRoute';
import { spamVerdictValidator } from '../lib/convexValidators';
import { virusVerdictValidator } from '../lib/literalValidators';
import { deliveredEnvelopeFields } from './deliveryPipeline/ingestFields';

/**
 * The `inbound.mailbox.received` payload, checked before the delivery action
 * is called. Each field is the validator `mail.delivery.ingestFromWebhook`
 * declares for it (so the two cannot drift), except the ones this route
 * defaults: `cc`, `bcc` and `attachments` default to empty and `subject` to
 * `(no subject)`, so they may be absent here. The check has to run before
 * the action is called: a wrong type reaching the action's validator surfaces
 * as a 500, while refusing it here answers a 400 that names the path.
 */
const mailboxPayloadValidator = v.object({
	deliveryId: v.string(),
	recipientAddress: v.string(),
	rawBytesBase64: v.string(),
	from: deliveredEnvelopeFields.from,
	to: deliveredEnvelopeFields.to,
	cc: v.optional(deliveredEnvelopeFields.cc),
	bcc: v.optional(deliveredEnvelopeFields.bcc),
	replyTo: deliveredEnvelopeFields.replyTo,
	// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
	// sender. Used to suppress vacation auto-replies to bounces (RFC 3834 §2).
	returnPath: v.optional(v.string()),
	subject: v.optional(deliveredEnvelopeFields.subject),
	textBody: v.optional(v.string()),
	htmlBody: v.optional(v.string()),
	messageId: deliveredEnvelopeFields.messageId,
	inReplyTo: deliveredEnvelopeFields.inReplyTo,
	references: deliveredEnvelopeFields.references,
	date: v.optional(v.number()),
	attachments: v.optional(deliveredEnvelopeFields.attachments),
	spamScore: v.optional(v.number()),
	spamVerdict: v.optional(spamVerdictValidator),
	virusVerdict: v.optional(virusVerdictValidator),
	spfResult: v.optional(v.string()),
	dkimResult: v.optional(v.string()),
	dmarcResult: v.optional(v.string()),
	dmarcPolicy: v.optional(v.string()),
	// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
	// stored beside the verdicts on `mailMessages`. Both optional.
	envelopeFromDomain: v.optional(v.string()),
	dkimSigningDomain: v.optional(v.string()),
	// Verified inbound ARC verdict (RFC 8617, Sealed Mail A5). Used to rescue a
	// DMARC fail when a TRUSTED forwarder sealed a valid chain attesting the
	// original passed. All optional — an older MTA omits them (no rescue).
	arcCv: v.optional(v.string()),
	arcSealerDomain: v.optional(v.string()),
	arcAttestsOriginalPass: v.optional(v.boolean()),
});

const mailWebhookPayloadValidator = v.object({ mailboxPayload: mailboxPayloadValidator });

export const handleMailWebhook = httpAction(async (ctx, request) => {
	const verified = await readVerifiedMtaBody(ctx, request, {
		logTag: '[Mail Webhook]',
		rateLimitKeyPrefix: 'mta-mailbox',
	});
	if (!verified.ok) return verified.response;
	const { bodyText } = verified;

	// Parsed to `unknown`: the audit below reads identifiers off whatever
	// arrived, and the shape is checked only once the event is known.
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		parsed = null;
	}
	const envelope = parsed === null ? null : isRecord(parsed) ? parsed : {};

	// Audit EVERY body, including one we could not parse — an MTA sending us
	// garbage is precisely the thing the audit trail is for. The write starts
	// first but runs beside the delivery rather than ahead of it (it never
	// rejects: a failed audit write is logged, not thrown), and every response
	// below waits for it, so no request is answered unaudited.
	const mpAudit = isRecord(envelope?.['mailboxPayload']) ? envelope['mailboxPayload'] : undefined;
	const audited = storeRawRouteAudit(ctx, {
		source: 'mta-mailbox',
		logTag: '[Mail Webhook]',
		bodyText,
		payload: envelope,
		envelope: {
			deliveryId: clampAuditField(mpAudit?.['deliveryId']),
			messageId: clampAuditField(mpAudit?.['messageId']),
			recipientAddress: clampAuditField(mpAudit?.['recipientAddress']),
			from: clampAuditField(mpAudit?.['from']),
			rawMessageBytes: base64ByteLength(mpAudit?.['rawBytesBase64']),
			attachmentCount: Array.isArray(mpAudit?.['attachments'])
				? mpAudit['attachments'].length
				: undefined,
		},
	});

	if (!envelope) {
		await audited;
		return jsonResponse(400, { error: 'Invalid JSON' });
	}

	if (envelope['event'] !== 'inbound.mailbox.received' || !envelope['mailboxPayload']) {
		await audited;
		return unsupportedEventResponse(envelope['event']);
	}

	// Accept and drop while the workspace is being deleted (see
	// `webhooks/workspaceDeletionAck.ts`): no raw bytes stored, no DLQ replay.
	if (await isWorkspaceBeingDeleted(ctx)) {
		await audited;
		return workspaceDeletionAck('[Mail Webhook]');
	}

	const decoded = decodeJsonValue(envelope, mailWebhookPayloadValidator);
	if (!decoded.ok) {
		await audited;
		return jsonResponse(400, { error: decoded.failure.message });
	}
	const mp = decoded.value.mailboxPayload;

	try {
		const [result] = await Promise.all([
			ctx.runAction(internal.mail.delivery.ingestFromWebhook, {
				deliveryId: mp.deliveryId,
				rawBytesBase64: mp.rawBytesBase64,
				recipientAddress: mp.recipientAddress,
				from: mp.from,
				to: mp.to,
				cc: mp.cc ?? [],
				bcc: mp.bcc ?? [],
				replyTo: mp.replyTo,
				returnPath: mp.returnPath,
				subject: mp.subject || '(no subject)',
				textBody: mp.textBody,
				htmlBody: mp.htmlBody,
				messageId: mp.messageId,
				inReplyTo: mp.inReplyTo,
				references: mp.references,
				date: mp.date,
				attachments: mp.attachments ?? [],
				spamScore: mp.spamScore,
				spamVerdict: mp.spamVerdict,
				virusVerdict: mp.virusVerdict,
				spfResult: mp.spfResult,
				dkimResult: mp.dkimResult,
				dmarcResult: mp.dmarcResult,
				dmarcPolicy: mp.dmarcPolicy,
				arcCv: mp.arcCv,
				arcSealerDomain: mp.arcSealerDomain,
				arcAttestsOriginalPass: mp.arcAttestsOriginalPass,
				envelopeFromDomain: mp.envelopeFromDomain,
				dkimSigningDomain: mp.dkimSigningDomain,
			}),
			audited,
		]);

		return jsonResponse(200, { success: true, result });
	} catch (err) {
		await audited;
		// A deletion that began after the check above.
		if (isWorkspaceDeletionRefusal(err)) return workspaceDeletionAck('[Mail Webhook]');
		logError('[Mail Webhook] Delivery failed:', err);
		return jsonResponse(500, { error: 'Delivery failed' });
	}
});
