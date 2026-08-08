/**
 * Inbound channel adapter registry.
 *
 * Webhook adapters (the MTA's, and future Postmark/Mailgun/IMAP sources)
 * delegate payload parsing to a source-keyed adapter. Each adapter normalizes
 * the vendor-specific raw payload into a canonical `InboundEmailMessage` shape
 * so the persistence layer stays source-agnostic.
 *
 * Adding a new inbound source is a single new adapter file plus a
 * `registerInboundChannelAdapter()` call — no handler edits required.
 *
 * Each adapter owns the whole translation for its source: the vendor envelope
 * (Resend / Postmark / Mailgun all have different shells) and the inner field
 * extraction. Until the D10 honesty pass, the Resend adapter borrowed the inner
 * half from a bidirectional `EmailAdapter` whose other three methods were
 * fictions (a `send` that hard-returned failure, a `healthCheck` that
 * hard-returned healthy, a `validateSignature` that hard-returned true); that
 * class is gone and its one real method is inlined below, unchanged.
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
 * Source identifier — the registry key.
 */
export type InboundSource = 'mta' | 'resend' | 'ses' | 'postmark' | 'mailgun';

/**
 * Inbound channel adapter contract.
 *
 * Lighter than the full `ChannelAdapter` (which is bidirectional). This one is
 * inbound-only and produces a typed result instead of the looser
 * `ParsedMessage`.
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
export class MtaInboundAdapter implements InboundChannelAdapter {
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
		const p = env.inboundPayload;
		return {
			from: p.from,
			to: p.to,
			subject: p.subject,
			textBody: p.textBody,
			htmlBody: p.htmlBody,
			headers: p.headers,
			messageId: p.messageId ?? `unknown-${env.timestamp}`,
			inReplyTo: p.inReplyTo,
			references: p.references,
			attachments: p.attachments,
			timestamp: env.timestamp,
			spfResult: p.spfResult,
			dkimResult: p.dkimResult,
			dmarcResult: p.dmarcResult,
			dmarcPolicy: p.dmarcPolicy,
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
export class ResendInboundAdapter implements InboundChannelAdapter {
	source: InboundSource = 'resend';

	parseInbound(raw: unknown): InboundEmailMessage {
		const payload = raw as ResendInboundPayload;
		const timestamp = payload.timestamp ?? Date.now();
		return {
			from: payload.from ?? '',
			to: payload.to ?? '',
			subject: payload.subject ?? '',
			textBody: payload.textBody,
			htmlBody: payload.htmlBody,
			headers: {},
			messageId: payload.messageId ?? `unknown-${timestamp}`,
			inReplyTo: payload.inReplyTo,
			references: payload.references,
			attachments: [],
			timestamp,
		};
	}
}

const REGISTRY: Partial<Record<InboundSource, InboundChannelAdapter>> = {
	mta: new MtaInboundAdapter(),
	resend: new ResendInboundAdapter(),
};

/**
 * Look up the inbound adapter for a source. Throws if not registered so
 * callers can fail loudly when a webhook arrives from an unknown vendor.
 */
export function getInboundChannelAdapter(source: InboundSource): InboundChannelAdapter {
	const adapter = REGISTRY[source];
	if (!adapter) {
		throw new Error(
			`No inbound channel adapter registered for source "${source}". ` +
				`Register one with registerInboundChannelAdapter() from @owlat/channels.`
		);
	}
	return adapter;
}

/**
 * Register a custom adapter — used by tests or by new source implementations.
 */
export function registerInboundChannelAdapter(adapter: InboundChannelAdapter): void {
	REGISTRY[adapter.source] = adapter;
}
