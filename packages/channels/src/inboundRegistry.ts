/**
 * Inbound channel adapter registry.
 *
 * Webhook handlers (mtaWebhook, resendWebhook, future Postmark/Mailgun/IMAP)
 * delegate payload parsing to a source-keyed adapter. Each adapter normalizes
 * the vendor-specific raw payload into a canonical `InboundEmailMessage` shape
 * so the persistence layer stays source-agnostic.
 *
 * Adding a new inbound source is a single new adapter file plus a
 * `registerInboundChannelAdapter()` call — no handler edits required.
 *
 * Sits one level above the per-channel `EmailAdapter` in `./email.ts`:
 * EmailAdapter normalizes a single MTA-shaped payload; this registry normalizes
 * the vendor envelope (Resend / Postmark / Mailgun all have different shells)
 * and then optionally delegates to EmailAdapter for the inner field extraction.
 */

import { EmailAdapter } from './email';
import type { ParsedMessage } from './types';

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
 * `inbound.received` event shape used by `mtaWebhook.ts`.
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

/**
 * Stub adapter for Resend inbound webhooks. Resend doesn't ship inbound mail
 * routing today; included so callers can detect "source registered but not
 * implemented" vs "unknown source".
 */
export class ResendInboundAdapter implements InboundChannelAdapter {
	source: InboundSource = 'resend';
	private readonly emailAdapter = new EmailAdapter();

	parseInbound(raw: unknown): InboundEmailMessage {
		const parsed: ParsedMessage = this.emailAdapter.parseInbound(raw);
		const env = raw as { to?: string; timestamp?: number };
		return {
			from: parsed.from,
			to: env.to ?? '',
			subject: parsed.content.subject ?? '',
			textBody: parsed.content.text,
			htmlBody: parsed.content.html,
			headers: {},
			messageId: parsed.externalMessageId ?? `unknown-${parsed.timestamp}`,
			inReplyTo: parsed.metadata?.['inReplyTo'],
			references: parsed.metadata?.['references'],
			attachments: [],
			timestamp: parsed.timestamp ?? env.timestamp ?? Date.now(),
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
