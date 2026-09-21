/**
 * Generic shared-secret webhook adapter — verifies a constant-time
 * compare against the channel's stored Secret Key (falling back to
 * `GENERIC_WEBHOOK_SECRET`, see `../channelSecrets.ts`) taken from either
 * `x-webhook-secret` or `Authorization: Bearer ...`, then parses a JSON envelope
 * (`{from ?? sender ?? 'webhook'}`, text/message/content cascades) into
 * a `channel.received` event with `channel: 'generic'`.
 *
 * No HMAC — the secret is a static shared value presented verbatim in a header.
 * A per-request HMAC would be strictly stronger (a captured request could not be
 * replayed against a different body), but the generic channel's wire contract is
 * "send us your secret", and existing integrations POST exactly that; swapping in
 * an HMAC scheme is a breaking change to every configured sender. Until that is
 * coordinated, replay is bounded two ways: this is the lowest-trust channel, the
 * pipeline rate-limits inbound traffic before the adapter runs, AND when the
 * sender supplies its own message `id` the downstream
 * `webhooks/channels.ts:processInboundChannel` dedupes on it
 * (`externalMessageId`) so a replayed request is a no-op.
 *
 * No `successResponse` — inherits the pipeline's default JSON envelope.
 */

import { constantTimeEqual } from '../security';
import { missingChannelSecretResult, resolveChannelInboundSecret } from '../channelSecrets';
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

	async verifySignature(request, _rawBody, ctx) {
		const secret = await resolveChannelInboundSecret(
			'generic',
			'signature',
			'GENERIC_WEBHOOK_SECRET',
			ctx
		);
		if (!secret) {
			return missingChannelSecretResult('GENERIC_WEBHOOK_SECRET', 'webhook channel Secret Key');
		}

		const provided = extractHeaderSecret(request);
		if (!provided) {
			return {
				ok: false,
				status: 401,
				reason: 'Missing authentication (x-webhook-secret or Authorization header)',
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
		const text = payload.text ?? payload.message ?? payload.content?.text ?? '';
		const externalId = payload.id ?? payload.messageId;
		const html = payload.html ?? payload.content?.html;
		const subject = payload.subject ?? payload.content?.subject;

		const content: NonNullable<Extract<InboundEvent, { kind: 'channel.received' }>['content']> = {
			text,
		};
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
