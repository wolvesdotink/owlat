/**
 * Wire-compat, Convex half: the adapter still puts the SAME BYTES on the wire.
 *
 * D7 moved the Convex<->MTA contract into `@owlat/mta-protocol` and typed both
 * ends against it. The stated risk of that move is that TS narrowing silently
 * changes wire semantics — a field renamed, reordered, defaulted or dropped by
 * the new declaration rather than by anyone's intent. Types cannot be tested,
 * so this drives the SHIPPED code and compares it against the frozen fixtures in
 * `@owlat/mta-protocol/wireFixtures` — the same module `apps/mta`'s handlers are
 * pinned to, so the two ends cannot agree with themselves and disagree with each
 * other.
 *
 * All four conversations, from this end: the send adapter's request bytes (plus
 * the Postbox producers', which share that body and are the only writers of
 * three of its fields), the decision answers it resolves, the webhook events its
 * ingress adapter parses, and the ip-reputation snapshot its normalizer accepts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DECISION_DEFER_BYTES,
	DECISION_MTA_BYTES,
	DECISION_RELAY_ALLOWED_BYTES,
	DECISION_RELAY_REASON_BYTES,
	GOVERNED_SEND_REQUEST_BYTES,
	IP_REPUTATION_SNAPSHOT_BYTES,
	POSTBOX_SEND_REQUEST_BYTES,
	SEND_ACCEPTED_BYTES,
	SEND_DEDUPLICATED_BYTES,
	SEND_INTAKE_PENDING_BYTES,
	SYSTEM_SEND_REQUEST_BYTES,
	WEBHOOK_EVENT_BYTES,
	WIRE_FIXTURE_NOW,
} from '@owlat/mta-protocol/wireFixtures';
import { normalizeIpReputationPayload } from '@owlat/mta-protocol/ipReputation';
import {
	MTA_WEBHOOK_EVENT_TYPES,
	type MtaWebhookEventType,
} from '@owlat/mta-protocol/webhookEvent';
import type { InboundEventKind } from '../../../webhooks/types';
import {
	MTA_DEFER_REASON_ORIGIN,
	MTA_ROUTING_DECISION_REQUEST_KEYS,
} from '@owlat/mta-protocol/routingDecision';
import type { MtaSendRequest } from '@owlat/mta-protocol/send';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';
import { EmailErrorCode } from '../types';
import { resolveSendTransport } from '../transports';
import { mtaAdapter } from '../../../webhooks/adapters/mta';
import { forwardToTarget } from '../../../mail/deliveryHooks';

const GOVERNED = JSON.parse(GOVERNED_SEND_REQUEST_BYTES) as MtaSendRequest;
const SYSTEM = JSON.parse(SYSTEM_SEND_REQUEST_BYTES) as MtaSendRequest;

const originalFetch = global.fetch;
let captured: { url: string; body: string } | null = null;

function stubFetch(response: Response) {
	global.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
		captured = { url: String(url), body: String(init?.body ?? '') };
		return response;
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	captured = null;
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
});

afterEach(() => {
	vi.unstubAllEnvs();
	global.fetch = originalFetch;
});

describe('Convex -> MTA send intake bytes', () => {
	it('serializes a governed send exactly as the frozen fixture', async () => {
		stubFetch(new Response(SEND_ACCEPTED_BYTES, { status: 200 }));
		const attempt = await mtaSendProvider.sendEmail(
			resolveSendTransport('mta'),
			{
				to: GOVERNED.to,
				from: GOVERNED.from,
				subject: GOVERNED.subject,
				html: GOVERNED.html,
				text: GOVERNED.text,
				replyTo: GOVERNED.replyTo,
				headers: GOVERNED.headers,
			},
			{
				messageId: GOVERNED.messageId,
				workAttemptId: GOVERNED.workAttemptId,
				routingReentryToken: GOVERNED.routingReentryToken,
				routingReentry: GOVERNED.routingReentry,
				ipPool: GOVERNED.ipPool,
				engagementScore: GOVERNED.engagementScore as number,
				dkimDomain: GOVERNED.dkimDomain,
				organizationId: GOVERNED.organizationId,
				messageType: GOVERNED.messageType,
				deliveryDomain: GOVERNED.deliveryDomain,
				routingLease: GOVERNED.routingLease,
				allowWarmupOverflow: GOVERNED.allowWarmupOverflow,
			}
		);

		expect(captured?.url).toBe('https://mta.test/send');
		expect(captured?.body).toBe(GOVERNED_SEND_REQUEST_BYTES);
		expect(attempt).toEqual({ success: true, id: 'send-fixture-1' });
	});

	it('serializes a system send exactly as the frozen fixture', async () => {
		stubFetch(new Response(SEND_ACCEPTED_BYTES, { status: 200 }));
		await mtaSendProvider.sendEmail(
			resolveSendTransport('mta'),
			{
				to: SYSTEM.to,
				from: SYSTEM.from,
				subject: SYSTEM.subject,
				html: SYSTEM.html,
			},
			{
				...mtaSendProvider.buildSystemMailExtras!({ idempotencyKey: SYSTEM.messageId }),
				dkimDomain: SYSTEM.dkimDomain,
			}
		);

		// The fixed-scope intake, and the body its three constants produce.
		expect(captured?.url).toBe('https://mta.test/send/system');
		expect(captured?.body).toBe(SYSTEM_SEND_REQUEST_BYTES);
	});

	it('omits absent optional fields rather than zeroing them', async () => {
		stubFetch(new Response(SEND_ACCEPTED_BYTES, { status: 200 }));
		await mtaSendProvider.sendEmail(resolveSendTransport('mta'), {
			to: 'recipient@example.com',
			from: 'sender@mail.example.org',
			subject: 'bare',
			html: '<p>bare</p>',
		});
		const body = JSON.parse(captured!.body) as Record<string, unknown>;
		// The MTA reads an absent engagementScore as "unknown" and applies its
		// DEFAULT band, whereas 0 would order the message behind every cold
		// contact — so the key must be missing, not present-and-falsy.
		expect(Object.keys(body)).not.toContain('engagementScore');
		expect(Object.keys(body)).not.toContain('routingLease');
		expect(body['ipPool']).toBe('transactional');
	});

	it('reads an accepted answer’s id as the caller’s message id', async () => {
		stubFetch(new Response(SEND_DEDUPLICATED_BYTES, { status: 200 }));
		const attempt = await mtaSendProvider.sendEmail(resolveSendTransport('mta'), {
			to: 'recipient@example.com',
			from: 'sender@mail.example.org',
			subject: 'dedup',
			html: '<p>dedup</p>',
		});
		expect(attempt).toEqual({ success: true, id: 'send-fixture-1' });
	});

	it('reads a 2xx body that is a JSON scalar as a plain failure, not acceptance-unknown', async () => {
		// A 200 whose body is a bare JSON scalar is legal JSON and nonsense as an
		// answer. It must stay what it always was — a definite failure — because
		// `acceptanceUnknown` sends a custody-taking transport into an acceptance
		// RECONCILIATION replay rather than recording the attempt as failed. This
		// is the exact shape the D7 narrowing could have moved: `'success' in
		// result` throws on a primitive where `result.success` does not.
		stubFetch(new Response('123', { status: 200 }));
		const attempt = await mtaSendProvider.sendEmail(resolveSendTransport('mta'), {
			to: 'recipient@example.com',
			from: 'sender@mail.example.org',
			subject: 'scalar',
			html: '<p>scalar</p>',
		});
		expect(attempt).toEqual({
			success: false,
			errorMessage: 'MTA returned unsuccessful response',
			errorCode: EmailErrorCode.UNKNOWN,
		});
		expect(attempt).not.toHaveProperty('acceptanceUnknown');
	});

	it('reads a pending intake reservation as acceptance-unknown, never as failure', async () => {
		stubFetch(new Response(SEND_INTAKE_PENDING_BYTES, { status: 409 }));
		const attempt = await mtaSendProvider.sendEmail(resolveSendTransport('mta'), {
			to: 'recipient@example.com',
			from: 'sender@mail.example.org',
			subject: 'pending',
			html: '<p>pending</p>',
		});
		expect(attempt).toEqual({
			success: false,
			errorMessage: SEND_INTAKE_PENDING_BYTES,
			errorCode: EmailErrorCode.SERVER_ERROR,
			retryAfterMs: 1_000,
			acceptanceUnknown: true,
		});
	});
});

describe('Convex -> MTA postbox intake bytes', () => {
	// The Postbox leg has three producers, none of them the send adapter:
	// `mail/outbound.ts` and the forward + vacation reply in
	// `mail/deliveryHooks.ts`. They are the only writers of `sealedMimeBase64`,
	// `amp` and `allowedFromAddresses`, so before D7 bound them to
	// `MtaSendRequest` those three fields had no typed producer anywhere. The
	// forward is the one of the three that is exported and drivable, so it is
	// what pins the CODE here; the other two are pinned by the type and by
	// `apps/mta`'s postbox intake tests over the same frozen fixture.
	const POSTBOX = JSON.parse(POSTBOX_SEND_REQUEST_BYTES) as MtaSendRequest;
	const WIRE_KEYS = new Set(Object.keys(POSTBOX));

	it('posts a forward whose every key is a field the frozen postbox body declares', async () => {
		stubFetch(new Response('{}', { status: 200 }));
		await forwardToTarget(
			{ baseUrl: 'https://mta.test', apiKey: 'test-key' },
			{
				mailboxId: 'mailbox1',
				mailboxAddress: 'me@owlat.test',
				fromAddress: 'alice@external.example',
				subject: 'Hello',
				bodyText: 'plain body',
				bodyHtml: '<p>hi</p>',
			},
			'forward-target@elsewhere.example'
		);

		expect(captured?.url).toBe('https://mta.test/send/postbox');
		const body = JSON.parse(captured!.body) as Record<string, unknown>;
		// `replyTo` is the one key the forward adds over the frozen body (it is
		// what keeps the original sender reachable, RFC 7960); `amp` is the one it
		// never sets. Everything else is key-for-key the same wire.
		expect(
			Object.keys(body)
				.filter((key) => key !== 'replyTo')
				.sort()
		).toEqual([...WIRE_KEYS].filter((key) => key !== 'amp').sort());
		// The field the MTA enforces From ownership with. A rename that reached
		// only one end refuses every forward, every vacation reply and every
		// personal-mailbox send with a 403.
		expect(body['allowedFromAddresses']).toEqual(['me@owlat.test']);
		expect(body['organizationId']).toBe('postbox');
	});
});

describe('MTA -> Convex routing decision bytes', () => {
	const input = {
		messageId: 'send-fixture-1',
		workAttemptId: 'work-fixture-1',
		routingReentryToken: 'reentry-fixture-1',
		startedAt: WIRE_FIXTURE_NOW,
		deliveryDomain: 'production' as const,
		messageType: 'campaign' as const,
		organizationId: 'org-fixture-1',
		recipient: 'recipient@example.com',
		from: 'sender@mail.example.org',
		candidateProvider: 'mta' as const,
		ipPool: 'campaign' as const,
		allowWarmupOverflow: true,
	};

	it('posts exactly the keys the contract declares required, and no other', async () => {
		stubFetch(new Response(DECISION_MTA_BYTES, { status: 200 }));
		await resolveMtaRoutingDecision(resolveSendTransport('mta'), input);
		const body = JSON.parse(captured!.body) as Record<string, unknown>;
		// The MTA's `validRequest` checks an EXACT key list, and takes BOTH its
		// lists from the package now. This is the other half of that statement:
		// the producer puts those same keys on the wire and nothing else, so an
		// enlarged contract cannot reach the intake ahead of its reader — which
		// would be answered 400, and a 400 is indistinguishable here from an
		// unreachable MTA, so every governed own-MTA send would defer as `local`.
		expect(Object.keys(body).sort()).toEqual([...MTA_ROUTING_DECISION_REQUEST_KEYS].sort());
	});

	it('resolves the frozen mta answer into the lease it grants', async () => {
		stubFetch(new Response(DECISION_MTA_BYTES, { status: 200 }));
		expect(await resolveMtaRoutingDecision(resolveSendTransport('mta'), input)).toEqual({
			kind: 'mta',
			leaseToken: 'lease-fixture-1',
			isProviderProbe: false,
			isGlobalProbe: false,
		});
		expect(captured?.url).toBe('https://mta.test/send/decision');
	});

	it('names the reason-less relay answer', async () => {
		stubFetch(new Response(DECISION_RELAY_ALLOWED_BYTES, { status: 200 }));
		expect(
			await resolveMtaRoutingDecision(resolveSendTransport('mta'), {
				...input,
				candidateProvider: 'relay',
			})
		).toEqual({ kind: 'relay', reason: 'relay_allowed' });
	});

	it.each(Object.entries(DECISION_RELAY_REASON_BYTES))(
		'resolves the frozen %s relay answer',
		async (reason, bytes) => {
			stubFetch(new Response(bytes, { status: 200 }));
			expect(await resolveMtaRoutingDecision(resolveSendTransport('mta'), input)).toEqual({
				kind: 'relay',
				reason,
			});
		}
	);

	it.each(Object.entries(DECISION_DEFER_BYTES))(
		'resolves the frozen %s defer answer with the origin the one table names',
		async (reason, bytes) => {
			stubFetch(new Response(bytes, { status: 200 }));
			expect(await resolveMtaRoutingDecision(resolveSendTransport('mta'), input)).toEqual({
				kind: 'defer',
				retryAfterMs: 60_000,
				origin: MTA_DEFER_REASON_ORIGIN[reason as keyof typeof MTA_DEFER_REASON_ORIGIN],
			});
		}
	);

	it('refuses a defer reason the one table does not vouch for', async () => {
		stubFetch(
			new Response('{"decision":"defer","reason":"brand_new_reason","retryAfterMs":60000}', {
				status: 200,
			})
		);
		// LOCAL: an answer we did not understand is not an observation about this
		// sending identity, so gate 2 must not count it.
		expect(await resolveMtaRoutingDecision(resolveSendTransport('mta'), input)).toEqual({
			kind: 'defer',
			retryAfterMs: 60_000,
			origin: 'local',
		});
	});
});

describe('MTA -> Convex webhook event bytes', () => {
	// Absorbing the two webhook-event declarations into one is the change most
	// able to move this wire silently, because the merged field set is WIDER than
	// either half was. So drive the shipped ingress — `parseEvent` runs
	// `isMtaWebhookEvent` and then each variant's own required-field check — and
	// prove the frozen bytes still come out as the inbound event they always did.
	// A field the union stopped requiring, or started requiring, lands as `null`.
	// EVERY kind the wire contract declares maps through the adapter's
	// exhaustive parser registry. The Record annotation is a compile-time
	// never-assertion of its own: a kind added to `MTA_WEBHOOK_EVENT_TYPES`
	// is a missing property here — and a missing fixture in
	// `WEBHOOK_EVENT_BYTES` — until this round-trip names its meaning.
	// `null` marks the ONE explicit ignore entry: `inbound.mailbox.received`
	// is served by `POST /webhooks/mta-mailbox` (`mail/webhook.ts`), never by
	// this adapter's route.
	const EXPECTED_INBOUND_KIND: Record<MtaWebhookEventType, InboundEventKind | null> = {
		sent: 'email.delivered',
		bounced: 'email.bounced',
		failed: 'email.failed',
		complained: 'email.complained',
		'smtp.classified': 'internal.smtp_classified',
		'org.circuit_breaker': 'internal.circuit_breaker_tripped',
		'campaign.complaint_rate': 'internal.campaign_complaint_rate',
		'ip.blocklisted': 'internal.ip_event',
		'ip.delisted': 'internal.ip_event',
		'ip.warming_complete': 'internal.ip_event',
		all_ips_blocked: 'internal.ip_event',
		'postmaster.authorize_domain': 'internal.postmaster_authorize_domain',
		'postmaster.stats': 'internal.postmaster_stats',
		'postmaster.compliance': 'internal.postmaster_compliance',
		'dkim.rotated': 'internal.dkim_rotated',
		'inbound.received': 'inbound.received',
		'routing.reentry': 'internal.routing_reentry',
		'inbound.mailbox.received': null,
		'ip.readiness_regressed': 'internal.ip_readiness_regressed',
		'deliverability.probe_observed': 'internal.deliverability_probe_observed',
	};

	it.each(MTA_WEBHOOK_EVENT_TYPES)(
		'parses the frozen %s event through the exhaustive registry',
		(event) => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const parsed = mtaAdapter.parseEvent(WEBHOOK_EVENT_BYTES[event]);
				const expected = EXPECTED_INBOUND_KIND[event];
				if (expected === null) {
					// The explicit ignore entry acks without dispatch, but observably.
					expect(parsed).toBeNull();
					expect(warn).toHaveBeenCalledOnce();
				} else {
					expect(parsed).toMatchObject({ kind: expected });
					expect(warn).not.toHaveBeenCalled();
				}
			} finally {
				warn.mockRestore();
			}
		}
	);

	it('carries the FBL provenance a complaint names off the merged field set', () => {
		// `reportedDomain`/`sourceIsp` live on the `complained` variant alone. The
		// merged declaration must not have quietly made them universal-and-absent.
		expect(mtaAdapter.parseEvent(WEBHOOK_EVENT_BYTES.complained)).toMatchObject({
			reportedDomain: 'mail.example.org',
			sourceIsp: 'yahoo',
		});
	});

	it('rejects an event the ingress guard does not recognise', () => {
		expect(mtaAdapter.parseEvent('{"event":"brand_new_event","timestamp":1750000000000}')).toBe(
			null
		);
	});
});

describe('MTA -> Convex ip-reputation snapshot bytes', () => {
	it('normalizes the frozen snapshot into the row the warming sync stores', () => {
		const normalized = normalizeIpReputationPayload(JSON.parse(IP_REPUTATION_SNAPSHOT_BYTES));
		expect(normalized).toMatchObject({
			phase: 'ramp',
			ipCount: 1,
			totalSentToday: 400,
		});
		expect(normalized?.ips[0]).toMatchObject({ ip: '192.0.2.10', dailyCap: expect.any(Number) });
	});
});
