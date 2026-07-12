/**
 * Inbound Email Forwarder
 *
 * Forwards parsed inbound emails to configured HTTP webhook endpoints.
 */

import type { ParsedMail } from 'mailparser';
import type { InboundRoute } from './router.js';
import { logger } from '../monitoring/logger.js';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

/**
 * RFC 8601 inbound authentication verdicts plus the DMARC alignment inputs,
 * as computed by the MTA over the raw bytes at ingest. Every field is optional:
 * a disabled check (or an absent identity) leaves it `undefined`, which the
 * downstream consumer must render as "unknown" — never as a pass.
 */
export interface InboundAuthVerdicts {
	/** SPF result on the SMTP envelope MAIL FROM (RFC 7208 §2.6 keyword). */
	spfResult?: string;
	/** DKIM result on the strongest signature (RFC 6376 / RFC 8601 keyword). */
	dkimResult?: string;
	/** DMARC result binding SPF/DKIM to the From domain (RFC 7489). */
	dmarcResult?: string;
	/** Published DMARC policy (`none`/`quarantine`/`reject`) for the From domain. */
	dmarcPolicy?: string;
	/** DMARC alignment input: the SMTP envelope MAIL FROM domain. */
	envelopeFromDomain?: string;
	/** DMARC alignment input: the d= domain of the passing DKIM signature. */
	dkimSigningDomain?: string;
}

interface InboundEmailPayload {
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
		content: string; // base64
	}>;
	// RFC 8601 inbound auth verdicts + DMARC alignment inputs, so a webhook
	// consumer can render an honest sender-authenticity badge. All optional.
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	envelopeFromDomain?: string;
	dkimSigningDomain?: string;
}

/**
 * Forward a parsed email to the route's HTTP endpoint
 */
export async function forwardToEndpoint(
	parsed: ParsedMail,
	route: InboundRoute,
	recipientAddress: string,
	auth?: InboundAuthVerdicts
): Promise<boolean> {
	if (!route.endpointUrl) {
		logger.error({ routeId: route.id }, 'Route has no endpoint URL');
		return false;
	}

	const payload: InboundEmailPayload = {
		from: parsed.from?.text ?? '',
		to: recipientAddress,
		subject: parsed.subject ?? '',
		textBody: parsed.text,
		htmlBody: parsed.html || undefined,
		headers: {},
		date: parsed.date?.toISOString(),
		messageId: parsed.messageId,
		inReplyTo: parsed.inReplyTo,
		references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references,
		attachments: (parsed.attachments ?? []).map(att => ({
			filename: att.filename,
			contentType: att.contentType,
			size: att.size,
			content: att.content.toString('base64'),
		})),
		spfResult: auth?.spfResult,
		dkimResult: auth?.dkimResult,
		dmarcResult: auth?.dmarcResult,
		dmarcPolicy: auth?.dmarcPolicy,
		envelopeFromDomain: auth?.envelopeFromDomain,
		dkimSigningDomain: auth?.dkimSigningDomain,
	};

	// Copy relevant headers
	if (parsed.headers) {
		for (const [key, value] of parsed.headers) {
			if (typeof value === 'string') {
				payload.headers[key] = value;
			}
		}
	}

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

			const response = await fetch(route.endpointUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (response.ok) {
				logger.info({ routeId: route.id, to: recipientAddress }, 'Inbound email forwarded');
				return true;
			}

			logger.warn(
				{ routeId: route.id, status: response.status, attempt },
				'Inbound forward non-OK response'
			);
		} catch (err) {
			logger.warn({ routeId: route.id, attempt, err }, 'Inbound forward failed');
		}

		if (attempt < MAX_RETRIES) {
			await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
		}
	}

	return false;
}
