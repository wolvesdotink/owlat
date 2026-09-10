/**
 * Inbound channel adapter registry — vendor envelope → canonical inbound mail.
 *
 * A webhook route hands the raw body to the adapter for its source, which
 * normalizes it into the `InboundEmailMessage` that
 * `internal.inbound.receiveMessage` persists, so the persistence layer stays
 * source-agnostic. Adding a source is one adapter plus one entry in `ADAPTERS`.
 *
 * Each adapter owns the whole translation for its source: the vendor envelope
 * (Resend / Postmark / Mailgun all have different shells) and the inner field
 * extraction. Until the D10 honesty pass, the Resend adapter borrowed the inner
 * half from a bidirectional `EmailAdapter` whose other three methods were
 * fictions (a `send` that hard-returned failure, a `healthCheck` that
 * hard-returned healthy, a `validateSignature` that hard-returned true); that
 * class is gone and its one real method is inlined below, unchanged.
 *
 * This lived in `@owlat/channels` until the package was folded away: two files
 * behind a workspace boundary that only this folder ever crossed, next to the
 * bidirectional adapters that already moved to `convex/channels/adapters/`.
 */

/**
 * Canonical inbound email shape consumed by `internal.inbound.receiveMessage`.
 */
export interface InboundEmailMessage {
	from: string;
	to: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	headers: Record<string, string>;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	attachments: Array<{
		filename?: string;
		contentType: string;
		size: number;
		redisKey?: string;
	}>;
	/** Timestamp from the webhook envelope (ms since epoch). */
	timestamp: number;
	// RFC 8601 inbound auth verdicts, computed by the MTA at ingest and carried
	// through to `inboundMessages`. All optional: an older MTA (or a disabled
	// check) omits the field, which must render as "unknown" — never "pass".
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
}

/**
 * Source identifier — the registry key. Only sources with an adapter belong
 * here: a member without one is a lookup that compiles and then throws.
 */
export type InboundSource = 'mta' | 'resend';

/**
 * Inbound channel adapter contract — the whole of it.
 *
 * A source key and one translation function producing the canonical, fully
 * typed `InboundEmailMessage`. There is no outbound half, no health probe and
 * no signature check: sending belongs to the send-provider seam, and verifying
 * an inbound request belongs to the caller's own route handler
 * (`apps/api/convex/webhooks/adapters/`), which does it against a real secret
 * before it ever asks this registry to parse.
 */
export interface InboundChannelAdapter {
	source: InboundSource;
	parseInbound(raw: unknown): InboundEmailMessage;
}

/**
 * MTA adapter — owlat-mta service forwards inbound mail via the
 * `inbound.received` event shape parsed by the backend's
 * `webhooks/adapters/mta.ts`.
 */
class MtaInboundAdapter implements InboundChannelAdapter {
	source: InboundSource = 'mta';

	parseInbound(raw: unknown): InboundEmailMessage {
		const env = raw as {
			inboundPayload: {
				from: string;
				to: string;
				subject: string;
				textBody?: string;
				htmlBody?: string;
				headers: Record<string, string>;
				date?: string;
				messageId?: string;
				inReplyTo?: string;
				references?: string;
				attachments: Array<{
					filename?: string;
					contentType: string;
					size: number;
					redisKey?: string;
				}>;
				spfResult?: string;
				dkimResult?: string;
				dmarcResult?: string;
				dmarcPolicy?: string;
			};
			timestamp: number;
		};
		// Named `input` on purpose: check-body-access.sh treats a body-field read
		// off any other receiver as a stored-row read, and this file is the ingest
		// boundary — everything it reads came off the wire, never out of the DB.
		const input = env.inboundPayload;
		return {
			from: input.from,
			to: input.to,
			subject: input.subject,
			textBody: input.textBody,
			htmlBody: input.htmlBody,
			headers: input.headers,
			messageId: input.messageId ?? `unknown-${env.timestamp}`,
			inReplyTo: input.inReplyTo,
			references: input.references,
			attachments: input.attachments,
			timestamp: env.timestamp,
			spfResult: input.spfResult,
			dkimResult: input.dkimResult,
			dmarcResult: input.dmarcResult,
			dmarcPolicy: input.dmarcPolicy,
		};
	}
}

/** Flat inbound-mail payload shape the Resend adapter reads. */
interface ResendInboundPayload {
	from?: string;
	to?: string;
	subject?: string;
	textBody?: string;
	htmlBody?: string;
	messageId?: string;
	timestamp?: number;
	inReplyTo?: string;
	references?: string;
}

/**
 * Stub adapter for Resend inbound webhooks. Resend doesn't ship inbound mail
 * routing today; included so callers can detect "source registered but not
 * implemented" vs "unknown source".
 *
 * The field mapping is the one the deleted `EmailAdapter.parseInbound` applied,
 * inlined verbatim — including that a missing `messageId` falls back to
 * `unknown-<timestamp>` using the ALREADY-DEFAULTED timestamp, so the two
 * fields can never disagree about which clock produced them.
 */
class ResendInboundAdapter implements InboundChannelAdapter {
	source: InboundSource = 'resend';

	parseInbound(raw: unknown): InboundEmailMessage {
		const input = raw as ResendInboundPayload;
		const timestamp = input.timestamp ?? Date.now();
		return {
			from: input.from ?? '',
			to: input.to ?? '',
			subject: input.subject ?? '',
			textBody: input.textBody,
			htmlBody: input.htmlBody,
			headers: {},
			messageId: input.messageId ?? `unknown-${timestamp}`,
			inReplyTo: input.inReplyTo,
			references: input.references,
			attachments: [],
			timestamp,
		};
	}
}

const ADAPTERS: Record<InboundSource, InboundChannelAdapter> = {
	mta: new MtaInboundAdapter(),
	resend: new ResendInboundAdapter(),
};

/** Look up the inbound adapter for a source. Total over `InboundSource`. */
export function getInboundChannelAdapter(source: InboundSource): InboundChannelAdapter {
	return ADAPTERS[source];
}
