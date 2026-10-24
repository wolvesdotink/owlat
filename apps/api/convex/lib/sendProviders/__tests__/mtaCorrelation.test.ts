/**
 * The correlation id rides every Convex -> MTA send-path request as the
 * `x-owlat-correlation` HEADER and never in a body: the intake and decision
 * bodies are pinned byte-for-byte to `@owlat/mta-protocol/wireFixtures`, and
 * the decision intake checks an exact key list. These tests pin both halves:
 * the header is present (the caller's id, else a minted one) and the bodies are
 * still the frozen bytes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DECISION_MTA_BYTES,
	GOVERNED_SEND_REQUEST_BYTES,
	SEND_ACCEPTED_BYTES,
	WIRE_FIXTURE_NOW,
} from '@owlat/mta-protocol/wireFixtures';
import { MTA_ROUTING_DECISION_REQUEST_KEYS } from '@owlat/mta-protocol/routingDecision';
import type { MtaSendRequest } from '@owlat/mta-protocol/send';
import { CORRELATION_HEADER } from '@owlat/shared/correlation';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';
import { resolveSendTransport } from '../transports';
import { forwardToTarget } from '../../../mail/deliveryHooks';
import type { DispatchExtrasInput } from '../types';

const GOVERNED = JSON.parse(GOVERNED_SEND_REQUEST_BYTES) as MtaSendRequest;

const originalFetch = global.fetch;
let captured: { url: string; body: string; headers: Headers } | null = null;

function stubFetch(response: () => Response) {
	global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
		captured = {
			url: String(url),
			body: String(init?.body ?? ''),
			headers: new Headers(init?.headers),
		};
		return response();
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

function governedExtras(correlationId?: string) {
	return {
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
		...(correlationId ? { correlationId } : {}),
	};
}

const PARAMS = {
	to: GOVERNED.to,
	from: GOVERNED.from,
	subject: GOVERNED.subject,
	html: GOVERNED.html,
	text: GOVERNED.text,
	replyTo: GOVERNED.replyTo,
	headers: GOVERNED.headers,
};

describe('the send intake', () => {
	it('sends the caller correlation id as a header and leaves the body bytes unchanged', async () => {
		stubFetch(() => new Response(SEND_ACCEPTED_BYTES, { status: 200 }));

		await mtaSendProvider.sendEmail(
			resolveSendTransport('mta'),
			PARAMS,
			governedExtras('txn_V1StGXR8_Z5jdHi6')
		);

		expect(captured?.headers.get(CORRELATION_HEADER)).toBe('txn_V1StGXR8_Z5jdHi6');
		expect(captured?.body).toBe(GOVERNED_SEND_REQUEST_BYTES);
	});

	it('mints an id when the caller has none', async () => {
		stubFetch(() => new Response(SEND_ACCEPTED_BYTES, { status: 200 }));

		await mtaSendProvider.sendEmail(resolveSendTransport('mta'), PARAMS, governedExtras());

		expect(captured?.headers.get(CORRELATION_HEADER)).toMatch(/^mta_[0-9a-f]{32}$/);
	});

	it('maps the dispatch fact onto the MTA extras, and omits it when absent', () => {
		const facts = {
			idempotencyKey: 'send_1',
			workAttemptId: 'work_1',
			organizationId: 'org_1',
			messageType: 'transactional',
			deliveryDomain: 'production',
			routingReentryToken: 'token',
			routingReentry: {
				envelopeInput: {},
				retryState: { attempt: 1, startedAt: 1, idempotencyKey: 'send_1' },
			},
		} satisfies DispatchExtrasInput;

		expect(
			mtaSendProvider.buildDispatchExtras!({ ...facts, correlationId: 'txn_abc' })
		).toMatchObject({ correlationId: 'txn_abc' });
		const plain = mtaSendProvider.buildDispatchExtras!(facts) ?? {};
		expect('correlationId' in plain).toBe(false);
	});
});

describe('the routing decision', () => {
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

	it('carries the id as a header and keeps the exact body key list', async () => {
		stubFetch(() => new Response(DECISION_MTA_BYTES, { status: 200 }));

		await resolveMtaRoutingDecision(resolveSendTransport('mta'), input, 'dsp_abc');

		expect(captured?.headers.get(CORRELATION_HEADER)).toBe('dsp_abc');
		const body = JSON.parse(captured!.body) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([...MTA_ROUTING_DECISION_REQUEST_KEYS].sort());
	});
});

describe('the Postbox forward', () => {
	it('carries the hook correlation id as a header', async () => {
		stubFetch(() => new Response('{}', { status: 200 }));

		await forwardToTarget(
			{ baseUrl: 'https://mta.test', apiKey: 'test-key' },
			{
				mailboxId: 'mailbox1',
				mailboxAddress: 'me@owlat.test',
				fromAddress: 'alice@external.example',
				subject: 'Hello',
			},
			'forward-target@elsewhere.example',
			'fwd_abc'
		);

		expect(captured?.headers.get(CORRELATION_HEADER)).toBe('fwd_abc');
		expect(JSON.parse(captured!.body)).not.toHaveProperty('correlationId');
	});
});
