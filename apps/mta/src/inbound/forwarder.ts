/**
 * Inbound Email Forwarder
 *
 * Forwards parsed inbound emails to configured HTTP webhook endpoints.
 */

import type { ParsedMail } from 'mailparser';
import { createHmac } from 'crypto';
import type { InboundRoute } from './router.js';
import type { InboundAuthVerdicts } from '../types.js';
import { logger } from '../monitoring/logger.js';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

/**
 * Wire shape POSTed to a route's configured HTTP endpoint (distinct from the
 * Convex-webhook `InboundEmailPayload` in `../types.ts` — this one inlines
 * attachment bytes and carries the RFC 8601 auth verdicts + DMARC alignment
 * inputs so the endpoint can render an honest sender-authenticity badge).
 */
interface EndpointForwardPayload extends InboundAuthVerdicts {
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

	const payload: EndpointForwardPayload = {
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
		attachments: (parsed.attachments ?? []).map((att) => ({
			filename: att.filename,
			contentType: att.contentType,
			size: att.size,
			content: att.content.toString('base64'),
		})),
		...auth,
	};

	// Copy relevant headers
	if (parsed.headers) {
		for (const [key, value] of parsed.headers) {
			if (typeof value === 'string') {
				payload.headers[key] = value;
			}
		}
	}

	const body = JSON.stringify(payload);

	// System routes (e.g. the TLS-RPT reporting webhook) forward to one of our
	// own trusted Convex endpoints, so we HMAC-sign the body with the shared
	// webhook secret — same scheme the Convex handlers verify. Customer routes
	// carry no secret and stay unsigned.
	const signedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
	if (route.systemSecret) {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac('sha256', route.systemSecret)
			.update(`${timestamp}.${body}`)
			.digest('hex');
		signedHeaders['x-mta-timestamp'] = timestamp;
		signedHeaders['x-mta-signature'] = signature;
	}

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

			const response = await fetch(route.endpointUrl, {
				method: 'POST',
				headers: signedHeaders,
				body,
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
			await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
		}
	}

	return false;
}
