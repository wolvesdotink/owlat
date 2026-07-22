import { describe, it, expect } from 'vitest';
import { verifyMtaHeaders, mtaAdapter } from '../mta';

const SECRET = 'mta-test-secret';

async function signMta(timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${timestamp}.${body}`)
	);
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('verifyMtaHeaders', () => {
	const now = 1_700_000_000;
	const body = '{"event":"bounced","messageId":"m1","bounceType":"hard","timestamp":1700000000000}';

	it('accepts a valid signature', async () => {
		const ts = String(now);
		const sig = await signMta(ts, body);
		expect(await verifyMtaHeaders(body, sig, ts, SECRET, now)).toBe(true);
	});

	it('rejects tampered body', async () => {
		const ts = String(now);
		const sig = await signMta(ts, body);
		expect(await verifyMtaHeaders(body + 'x', sig, ts, SECRET, now)).toBe(false);
	});

	it('rejects stale timestamp', async () => {
		const stale = String(now - 400);
		const sig = await signMta(stale, body);
		expect(await verifyMtaHeaders(body, sig, stale, SECRET, now)).toBe(false);
	});

	it('rejects future-skewed timestamp', async () => {
		const future = String(now + 400);
		const sig = await signMta(future, body);
		expect(await verifyMtaHeaders(body, sig, future, SECRET, now)).toBe(false);
	});

	it('rejects unparseable timestamp', async () => {
		const sig = await signMta('not-a-number', body);
		expect(await verifyMtaHeaders(body, sig, 'not-a-number', SECRET, now)).toBe(false);
	});
});

describe('mtaAdapter.parseEvent', () => {
	it('parses an authenticated accepted-job routing re-entry with the same Send/idempotency', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'routing.reentry',
				messageId: 'send_campaign-1',
				message: 'breaker generation changed',
				routingReentryToken: 'rr1.authenticated-token',
				workAttemptId: 'work-attempt-1',
				routingReentryReason: 'circuit_breaker_changed',
				routingReentry: {
					envelopeInput: { kind: 'campaign', to: 'person@example.com' },
					retryState: {
						attempt: 1,
						startedAt: 1700000000000,
						idempotencyKey: 'send_campaign-1',
					},
				},
				timestamp: 1700000000000,
			})
		);
		expect(event).toMatchObject({
			kind: 'internal.routing_reentry',
			providerMessageId: 'send_campaign-1',
			token: 'rr1.authenticated-token',
			workAttemptId: 'work-attempt-1',
			reason: 'circuit_breaker_changed',
			retryState: { attempt: 1, idempotencyKey: 'send_campaign-1' },
		});
	});

	it('rejects a routing re-entry whose retry key does not match the accepted message', () => {
		expect(
			mtaAdapter.parseEvent(
				JSON.stringify({
					event: 'routing.reentry',
					messageId: 'send-1',
					routingReentryToken: 'rr1.authenticated-token',
					workAttemptId: 'work-attempt-1',
					routingReentryReason: 'routing_lease_stale',
					routingReentry: {
						envelopeInput: { kind: 'transactional' },
						retryState: { attempt: 1, startedAt: 1, idempotencyKey: 'send-other' },
					},
					timestamp: 1,
				})
			)
		).toBeNull();
	});

	it('parses bounced with hard classification', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'bounced',
				messageId: 'msg_1',
				bounceType: 'hard',
				message: 'user unknown',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'email.bounced',
			providerMessageId: 'msg_1',
			at: 1700000000000,
			bounceType: 'hard',
			bounceMessage: 'user unknown',
		});
	});

	it('defaults bounced to soft when bounceType absent', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'bounced',
				messageId: 'msg_1',
				timestamp: 1700000000000,
			})
		);
		expect(event).toMatchObject({ bounceType: 'soft' });
	});

	it('returns null for bounced without messageId', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({ event: 'bounced', timestamp: 1700000000000 })
		);
		expect(event).toBeNull();
	});

	// Fix 2 (P2): the MTA post-DATA ambiguous drop emits a terminal, NON-bounce
	// `failed` event so the send row leaves "sending". It maps to `email.failed`
	// (NOT `email.bounced`), which the dispatcher transitions to the `failed`
	// status WITHOUT recipient suppression.
	it('parses failed into a terminal email.failed (never email.bounced)', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'failed',
				messageId: 'msg_amb',
				message: 'Ambiguous post-DATA drop: connection reset',
				severity: 'warning',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'email.failed',
			providerMessageId: 'msg_amb',
			at: 1700000000000,
			errorMessage: 'Ambiguous post-DATA drop: connection reset',
			errorCode: 'ambiguous_post_data',
		});
		expect(event?.kind).not.toBe('email.bounced');
	});

	it('defaults the failed errorMessage when the message is absent', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({ event: 'failed', messageId: 'msg_amb', timestamp: 1700000000000 })
		);
		expect(event).toMatchObject({
			kind: 'email.failed',
			errorMessage: 'Delivery failed (ambiguous post-DATA drop)',
			errorCode: 'ambiguous_post_data',
		});
	});

	it('returns null for failed without messageId', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({ event: 'failed', timestamp: 1700000000000 })
		);
		expect(event).toBeNull();
	});

	it('parses complained', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'complained',
				messageId: 'msg_2',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'email.complained',
			providerMessageId: 'msg_2',
			at: 1700000000000,
		});
	});

	// PR-13: Gmail-style FBL redacts the original Message-ID but still names the
	// recipient (RFC 5965 §3.2). The complaint must survive as a recipient-only
	// event so the dispatcher can suppress by email.
	it('parses complained with only a recipient (no Message-ID)', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'complained',
				recipient: 'victim@example.com',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'email.complained',
			recipient: 'victim@example.com',
			at: 1700000000000,
		});
	});

	it('prefers the Message-ID over the recipient when both are present', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'complained',
				messageId: 'msg_2',
				recipient: 'victim@example.com',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'email.complained',
			providerMessageId: 'msg_2',
			at: 1700000000000,
		});
	});

	it('returns null for complained with neither Message-ID nor recipient', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({ event: 'complained', timestamp: 1700000000000 })
		);
		expect(event).toBeNull();
	});

	it('parses sent (Postbox-prefixed routed by dispatcher, not here)', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'sent',
				messageId: 'pb-123',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'email.delivered',
			providerMessageId: 'pb-123',
			at: 1700000000000,
		});
	});

	it('preserves Phase-2 Gmail provider identity and primary sending domain', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'sent',
				messageId: 'send_123',
				organizationId: 'org-a',
				recipient: 'user@workspace.example',
				destinationProvider: 'gmail',
				primarySendingDomain: 'example.co.uk',
				timestamp: 1700000000000,
			})
		);
		expect(event).toMatchObject({
			kind: 'email.delivered',
			organizationId: 'org-a',
			recipient: 'user@workspace.example',
			destinationProvider: 'gmail',
			primarySendingDomain: 'example.co.uk',
		});
	});

	it('parses inbound.received via @owlat/channels', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'inbound.received',
				timestamp: 1700000000000,
				inboundPayload: {
					from: 'sender@example.com',
					to: 'recipient@owlat.app',
					subject: 'Hi',
					textBody: 'hello',
					headers: { Date: 'Mon, 14 Nov 2023' },
					messageId: '<unique@example.com>',
					attachments: [],
				},
			})
		);
		expect(event?.kind).toBe('inbound.received');
		if (event?.kind === 'inbound.received') {
			expect(event.mail.from).toBe('sender@example.com');
			expect(event.mail.subject).toBe('Hi');
			expect(event.mail.messageId).toBe('<unique@example.com>');
		}
	});

	it('parses circuit_breaker', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'org.circuit_breaker',
				message: 'high bounce rate',
				bounceRate: 12.5,
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'internal.circuit_breaker_tripped',
			message: 'high bounce rate',
			bounceRate: 12.5,
		});
	});

	it('parses campaign.complaint_rate (not ignored) carrying campaignId + rate', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'campaign.complaint_rate',
				campaignId: 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4',
				complaintRate: 0.004,
				message: 'Campaign complaint rate 0.40% exceeded 0.3% threshold (4/1000)',
				severity: 'critical',
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'internal.campaign_complaint_rate',
			message: 'Campaign complaint rate 0.40% exceeded 0.3% threshold (4/1000)',
			campaignId: 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4',
			complaintRate: 0.004,
		});
	});

	it('defaults the campaign.complaint_rate message when absent', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'campaign.complaint_rate',
				campaignId: 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4',
				timestamp: 1700000000000,
			})
		);
		expect(event).toMatchObject({
			kind: 'internal.campaign_complaint_rate',
			campaignId: 'jh71d9k2m3n4p5q6r7s8t9v0w1x2y3z4',
		});
		// complaintRate omitted when not supplied.
		if (event?.kind === 'internal.campaign_complaint_rate') {
			expect(event.complaintRate).toBeUndefined();
		}
	});

	it.each([
		['ip.blocklisted', 'blocklisted'],
		['ip.delisted', 'delisted'],
		['ip.warming_complete', 'warming_complete'],
		['all_ips_blocked', 'all_blocked'],
	] as const)('parses %s → subkind=%s', (event, subkind) => {
		const parsed = mtaAdapter.parseEvent(
			JSON.stringify({
				event,
				ip: '10.0.0.1',
				severity: 'warning',
				timestamp: 1700000000000,
			})
		);
		expect(parsed).toMatchObject({
			kind: 'internal.ip_event',
			subkind,
			ip: '10.0.0.1',
			severity: 'warning',
		});
	});

	it('parses contract-shaped Google Postmaster spam-rate telemetry', () => {
		expect(
			mtaAdapter.parseEvent(
				JSON.stringify({
					event: 'postmaster.stats',
					domain: 'example.com',
					date: '2026-07-20',
					userReportedSpamRatio: 0.001,
					timestamp: 1700000000000,
				})
			)
		).toEqual({
			kind: 'internal.postmaster_stats',
			domain: 'example.com',
			date: '2026-07-20',
			userReportedSpamRatio: 0.001,
			fetchedAt: 1700000000000,
		});
	});

	it('parses and withholds raw audit for the Postmaster authorization protocol', async () => {
		const rawBody = JSON.stringify({
			event: 'postmaster.authorize_domain',
			domain: 'example.com',
			timestamp: 1700000000000,
		});
		expect(mtaAdapter.shouldStoreRawPayload?.(rawBody)).toBe(false);
		expect(mtaAdapter.parseEvent(rawBody)).toEqual({
			kind: 'internal.postmaster_authorize_domain',
			domain: 'example.com',
		});
		const response = mtaAdapter.successResponse!(mtaAdapter.parseEvent(rawBody)!, {
			authorized: false,
		});
		expect(await response.json()).toEqual({
			success: true,
			kind: 'internal.postmaster_authorize_domain',
			disposition: 'ignored_unowned',
			retained: false,
		});
	});

	it('keeps normal MTA events in raw audit while withholding Postmaster stats', () => {
		expect(
			mtaAdapter.shouldStoreRawPayload?.(
				JSON.stringify({ event: 'postmaster.stats', domain: 'private.example' })
			)
		).toBe(false);
		expect(
			mtaAdapter.shouldStoreRawPayload?.(
				JSON.stringify({ event: 'sent', messageId: 'message-1', timestamp: 1 })
			)
		).toBe(true);
	});

	it('drops missing or invalid Google Postmaster spam rates', () => {
		const base = {
			event: 'postmaster.stats',
			domain: 'example.com',
			date: '2026-07-20',
			timestamp: 1700000000000,
		};
		expect(mtaAdapter.parseEvent(JSON.stringify(base))).toBeNull();
		expect(
			mtaAdapter.parseEvent(JSON.stringify({ ...base, userReportedSpamRatio: '0.001' }))
		).toBeNull();
		expect(
			mtaAdapter.parseEvent(JSON.stringify({ ...base, userReportedSpamRatio: 1.1 }))
		).toBeNull();
	});

	it.each(['pending', 'activated'] as const)('parses dkim.rotated (phase=%s)', (phase) => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'dkim.rotated',
				domain: 'rotate.com',
				selector: 's2',
				dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
				phase,
				timestamp: 1700000000000,
			})
		);
		expect(event).toEqual({
			kind: 'internal.dkim_rotated',
			domain: 'rotate.com',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase,
		});
	});

	it('returns null for dkim.rotated missing required fields', () => {
		expect(
			mtaAdapter.parseEvent(
				JSON.stringify({
					event: 'dkim.rotated',
					selector: 's2',
					dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
					phase: 'pending',
					timestamp: 1700000000000,
				})
			)
		).toBeNull();
		expect(
			mtaAdapter.parseEvent(
				JSON.stringify({
					event: 'dkim.rotated',
					domain: 'rotate.com',
					selector: 's2',
					dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
					phase: 'bogus',
					timestamp: 1700000000000,
				})
			)
		).toBeNull();
	});

	it('returns null for unknown event types', () => {
		const event = mtaAdapter.parseEvent(
			JSON.stringify({
				event: 'something.weird',
				timestamp: 1700000000000,
			})
		);
		expect(event).toBeNull();
	});
});
