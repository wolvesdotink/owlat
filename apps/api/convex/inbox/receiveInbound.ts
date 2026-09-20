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
	// Named `input` on purpose, the same way the inbound adapter registry names
	// its receiver: `check-body-access.sh` treats a body-field read off any other
	// receiver as a stored-row read, and this is the INGEST BOUNDARY — every
	// field here came off the wire, never out of the database.
	input: InboundEmailMessage,
	extras: InboundReceiveExtras
): Promise<InboundReceiveResult> {
	const attachmentMeta =
		input.attachments.length > 0 ? JSON.stringify(input.attachments) : undefined;

	// Sealed Mail decrypt-on-ingest. When Sealed Mail is on and the body carries
	// an armored PGP ciphertext, route through the Node decrypt action. Anything
	// else — plaintext, flag off, or a ciphertext we cannot recover here — takes
	// the unchanged path below.
	const armoredCiphertext = input.textBody ? extractArmoredCiphertext(input.textBody) : null;
	if (armoredCiphertext && (await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
		return await ctx.runAction(internal.e2ee.open.decryptAndReceive, {
			armoredCiphertext,
			recipientAddress: input.to,
			from: input.from,
			to: input.to,
			subject: input.subject,
			textBody: input.textBody,
			htmlBody: input.htmlBody,
			headers: JSON.stringify(input.headers),
			messageId: input.messageId,
			inReplyTo: input.inReplyTo,
			references: input.references,
			attachmentMeta,
			timestamp: input.timestamp,
			spfResult: input.spfResult,
			dkimResult: input.dkimResult,
			dmarcResult: input.dmarcResult,
			dmarcPolicy: input.dmarcPolicy,
			...extras,
		});
	}

	return await ctx.runMutation(internal.inbox.messages.receiveMessage, {
		from: input.from,
		to: input.to,
		subject: input.subject,
		textBody: input.textBody,
		htmlBody: input.htmlBody,
		headers: JSON.stringify(input.headers),
		messageId: input.messageId,
		inReplyTo: input.inReplyTo,
		references: input.references,
		attachmentMeta,
		timestamp: input.timestamp,
		// RFC 8601 inbound auth verdicts, persisted so the reader can show an
		// honest sender badge.
		spfResult: input.spfResult,
		dkimResult: input.dkimResult,
		dmarcResult: input.dmarcResult,
		dmarcPolicy: input.dmarcPolicy,
		// AI-inbox mirror of the clearsigned-body signature verdict —
		// see webhooks/inboundSignatureMirror.ts. Best-effort, never blocks.
		...((await clearsignedSignatureMirror(ctx, input.textBody, input.from)) ?? {}),
		...extras,
	});
}
