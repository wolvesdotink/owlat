/**
 * Sealed Mail A1 — inbound forwarder webhook payload.
 *
 * `forwardToEndpoint` POSTs a parsed inbound email to an endpoint-mode route's
 * webhook. This asserts the RFC 8601 auth verdicts (SPF/DKIM/DMARC + policy)
 * and the two DMARC alignment domains the MTA now computes travel in that
 * payload beside the message, and that omitting them leaves the fields absent
 * (never fabricated).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedMail } from 'mailparser';
import { forwardToEndpoint } from '../forwarder.js';
import type { InboundAuthVerdicts } from '../../types.js';
import type { InboundRoute } from '../router.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const route: InboundRoute = {
	id: 'r-1',
	domain: 'org.example',
	address: 'support',
	mode: 'endpoint',
	endpointUrl: 'https://hook.example/inbound',
	organizationId: 'org-1',
	createdAt: 0,
};

const parsed = {
	from: { text: 'Alice <alice@sender.example>' },
	subject: 'Hello',
	text: 'Body',
	attachments: [],
} as unknown as ParsedMail;

/** Capture the JSON body of the single fetch the forwarder makes. */
function mockFetchOk(): () => Record<string, unknown> {
	const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
	vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
	return () => {
		const body = fetchMock.mock.calls[0]?.[1]?.body as string;
		return JSON.parse(body) as Record<string, unknown>;
	};
}

describe('forwardToEndpoint — webhook payload auth verdicts (Sealed Mail A1)', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('includes SPF/DKIM/DMARC verdicts + the two alignment domains', async () => {
		const readBody = mockFetchOk();
		const auth: InboundAuthVerdicts = {
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			dmarcPolicy: 'reject',
			envelopeFromDomain: 'sender.example',
			dkimSigningDomain: 'sender.example',
		};

		const ok = await forwardToEndpoint(parsed, route, 'support@org.example', auth);
		expect(ok).toBe(true);

		const body = readBody();
		expect(body['spfResult']).toBe('pass');
		expect(body['dkimResult']).toBe('pass');
		expect(body['dmarcResult']).toBe('pass');
		expect(body['dmarcPolicy']).toBe('reject');
		expect(body['envelopeFromDomain']).toBe('sender.example');
		expect(body['dkimSigningDomain']).toBe('sender.example');
	});

	it('leaves the auth fields absent when no verdicts are supplied (old-MTA tolerance)', async () => {
		const readBody = mockFetchOk();

		const ok = await forwardToEndpoint(parsed, route, 'support@org.example');
		expect(ok).toBe(true);

		const body = readBody();
		expect(body['spfResult']).toBeUndefined();
		expect(body['dkimResult']).toBeUndefined();
		expect(body['dmarcResult']).toBeUndefined();
		expect(body['dmarcPolicy']).toBeUndefined();
		expect(body['envelopeFromDomain']).toBeUndefined();
		expect(body['dkimSigningDomain']).toBeUndefined();
		// The message envelope still travels.
		expect(body['from']).toBe('Alice <alice@sender.example>');
		expect(body['to']).toBe('support@org.example');
	});
});
