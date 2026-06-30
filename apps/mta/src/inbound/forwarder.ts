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
}

/**
 * Forward a parsed email to the route's HTTP endpoint
 */
export async function forwardToEndpoint(
	parsed: ParsedMail,
	route: InboundRoute,
	recipientAddress: string
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
