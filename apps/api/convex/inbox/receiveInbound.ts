/**
 * The one writer of a team-inbox `inboundMessages` row from a normalized
 * inbound mail event.
 *
 * TWO routes reach this table. `POST /webhooks/mta-inbound`
 * (`inbox/inboundWebhookHttp.ts` → `inbox/inboundIngest.ts`) is the one that
 * carries the raw message, so it is the one that has attachments, an antivirus
 * verdict and a downloadable `.eml`. `POST /webhooks/mta` stays alive behind
 * `webhooks/dispatcher.ts` for DLQ replays and for an MTA binary older than the
 * route split; it delivers the same mail without bytes.
 *
 * Both call THIS function, so the only thing the two paths can differ on is
 * what they were given. Sealed-mail detection, the attachment-metadata
 * serialization and the clearsigned signature mirror are decided once, here,
 * rather than in two handlers that would drift.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { extractArmoredCiphertext } from '@owlat/shared/secureMessage';
import { clearsignedSignatureMirror } from '../webhooks/inboundSignatureMirror';
import type { InboundEmailMessage } from '../webhooks/adapters/inboundRegistry';

/**
 * What the raw-carrying route knows and the legacy route does not.
 *
 * `virusVerdict` is deliberately three-valued plus absent: absent means NOTHING
 * WAS SCANNED (no attachments, or no scanner configured) and must never be
 * stored as `'clean'`.
 */
export interface InboundReceiveExtras {
	rawStorageId?: Id<'_storage'>;
	rawSize?: number;
	virusVerdict?: 'clean' | 'infected' | 'skipped';
}

export interface InboundReceiveResult {
	inboundMessageId: Id<'inboundMessages'>;
	threadId: Id<'conversationThreads'>;
	contactId: Id<'contacts'>;
}

/**
 * Persist one normalized inbound message, routing a sealed body through the
 * Node decrypt action first so the PLAINTEXT is what reaches `receiveMessage`
 * (and therefore the agent pipeline and the unified-timeline mirror).
 */
export async function receiveInboundMail(
	ctx: ActionCtx,
	m: InboundEmailMessage,
	extras: InboundReceiveExtras
): Promise<InboundReceiveResult> {
	const attachmentMeta = m.attachments.length > 0 ? JSON.stringify(m.attachments) : undefined;

	// Sealed Mail decrypt-on-ingest. When Sealed Mail is on and the body carries
	// an armored PGP ciphertext, route through the Node decrypt action. Anything
	// else — plaintext, flag off, or a ciphertext we cannot recover here — takes
	// the unchanged path below.
	const armoredCiphertext = m.textBody ? extractArmoredCiphertext(m.textBody) : null;
	if (armoredCiphertext && (await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
		return await ctx.runAction(internal.e2ee.open.decryptAndReceive, {
			armoredCiphertext,
			recipientAddress: m.to,
			from: m.from,
			to: m.to,
			subject: m.subject,
			textBody: m.textBody,
			htmlBody: m.htmlBody,
			headers: JSON.stringify(m.headers),
			messageId: m.messageId,
			inReplyTo: m.inReplyTo,
			references: m.references,
			attachmentMeta,
			timestamp: m.timestamp,
			spfResult: m.spfResult,
			dkimResult: m.dkimResult,
			dmarcResult: m.dmarcResult,
			dmarcPolicy: m.dmarcPolicy,
			...extras,
		});
	}

	return await ctx.runMutation(internal.inbox.messages.receiveMessage, {
		from: m.from,
		to: m.to,
		subject: m.subject,
		textBody: m.textBody,
		htmlBody: m.htmlBody,
		headers: JSON.stringify(m.headers),
		messageId: m.messageId,
		inReplyTo: m.inReplyTo,
		references: m.references,
		attachmentMeta,
		timestamp: m.timestamp,
		// RFC 8601 inbound auth verdicts, persisted so the reader can show an
		// honest sender badge.
		spfResult: m.spfResult,
		dkimResult: m.dkimResult,
		dmarcResult: m.dmarcResult,
		dmarcPolicy: m.dmarcPolicy,
		// AI-inbox mirror of the clearsigned-body signature verdict —
		// see webhooks/inboundSignatureMirror.ts. Best-effort, never blocks.
		...((await clearsignedSignatureMirror(ctx, m.textBody, m.from)) ?? {}),
		...extras,
	});
}
