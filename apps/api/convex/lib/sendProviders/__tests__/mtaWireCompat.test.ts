/**
 * Wire-compat, Convex half: the adapter still puts the SAME BYTES on the wire.
 *
 * D7 moved the Convex<->MTA contract into `@owlat/mta-protocol` and typed both
 * ends against it. The stated risk of that move is that TS narrowing silently
 * changes wire semantics — a field renamed, reordered, defaulted or dropped by
 * the new declaration rather than by anyone's intent. Types cannot be tested,
 * so this drives the SHIPPED adapter and compares what it hands `fetch` against
 * the frozen fixtures in `@owlat/mta-protocol/wireFixtures` — the same module
 * `apps/mta`'s handlers are pinned to, so the two ends cannot agree with
 * themselves and disagree with each other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DECISION_DEFER_BYTES,
	DECISION_MTA_BYTES,
	DECISION_RELAY_ALLOWED_BYTES,
	DECISION_RELAY_REASON_BYTES,
	GOVERNED_SEND_REQUEST_BYTES,
	IP_REPUTATION_SNAPSHOT_BYTES,
	SEND_ACCEPTED_BYTES,
	SEND_DEDUPLICATED_BYTES,
	SEND_INTAKE_PENDING_BYTES,
	SYSTEM_SEND_REQUEST_BYTES,
} from '@owlat/mta-protocol/wireFixtures';
import { normalizeIpReputationPayload } from '@owlat/mta-protocol/ipReputation';
import { MTA_DEFER_REASON_ORIGIN } from '@owlat/mta-protocol/routingDecision';
import type { MtaSendRequest } from '@owlat/mta-protocol/send';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';
import { EmailErrorCode } from '../types';
import { resolveSendTransport } from '../transports';

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

describe('MTA -> Convex routing decision bytes', () => {
	const input = {
		messageId: 'send-fixture-1',
		workAttemptId: 'work-fixture-1',
		routingReentryToken: 'reentry-fixture-1',
		startedAt: 1_750_000_000_000,
		deliveryDomain: 'production' as const,
		messageType: 'campaign' as const,
		organizationId: 'org-fixture-1',
		recipient: 'recipient@example.com',
		from: 'sender@mail.example.org',
		candidateProvider: 'mta' as const,
		ipPool: 'campaign' as const,
		allowWarmupOverflow: true,
	};

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
