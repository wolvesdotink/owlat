/**
 * Generic shared-secret webhook adapter — verifies a constant-time
 * compare against `GENERIC_WEBHOOK_SECRET` from either `x-webhook-secret`
 * or `Authorization: Bearer ...`, then parses a forgiving JSON envelope
 * (`{from ?? sender ?? 'webhook'}`, text/message/content cascades) into
 * a `channel.received` event with `channel: 'generic'`.
 *
 * No HMAC — the secret is a static shared value. This is the
 * lowest-trust channel; the pipeline rate-limits inbound traffic before
 * the adapter runs to limit abuse exposure.
 *
 * No `successResponse` — inherits the pipeline's default JSON envelope.
 */

import { getOptional } from '../../lib/env';
import { constantTimeEqual } from '../security';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

interface GenericPayload {
	from?: string;
	sender?: string;
	id?: string;
	messageId?: string;
	text?: string;
	message?: string;
	html?: string;
	subject?: string;
	content?: { text?: string; html?: string; subject?: string };
	metadata?: Record<string, string | undefined>;
}

function extractHeaderSecret(request: Request): string | null {
	const direct = request.headers.get('x-webhook-secret');
	if (direct) return direct;
	const auth = request.headers.get('authorization');
	if (auth) return auth.replace(/^Bearer\s+/i, '');
	return null;
}

export const genericAdapter: InboundAdapter = {
	source: 'generic',

	async verifySignature(request) {
		const secret = getOptional('GENERIC_WEBHOOK_SECRET');
		if (!secret) {
			return {
				ok: false,
				status: 503,
				reason:
					'Webhook endpoint is not configured securely (missing GENERIC_WEBHOOK_SECRET)',
			};
		}

		const provided = extractHeaderSecret(request);
		if (!provided) {
			return {
				ok: false,
				status: 401,
				reason:
					'Missing authentication (x-webhook-secret or Authorization header)',
			};
		}

		if (!constantTimeEqual(provided, secret)) {
			return { ok: false, status: 401, reason: 'Invalid shared secret' };
		}

		return { ok: true };
	},

	parseEvent(rawBody): InboundEvent | null {
		const payload = JSON.parse(rawBody) as GenericPayload;

		const from = payload.from ?? payload.sender ?? 'webhook';
		const text =
			payload.text ?? payload.message ?? payload.content?.text ?? '';
		const externalId = payload.id ?? payload.messageId;
		const html = payload.html ?? payload.content?.html;
		const subject = payload.subject ?? payload.content?.subject;

		const content: NonNullable<
			Extract<InboundEvent, { kind: 'channel.received' }>['content']
		> = { text };
		if (html) content.html = html;
		if (subject) content.subject = subject;

		return {
			kind: 'channel.received',
			channel: 'generic',
			from,
			content,
			...(externalId ? { externalMessageId: externalId } : {}),
			...(payload.metadata ? { metadata: payload.metadata } : {}),
		};
	},
};
