/**
 * The outbound webhook signature (GHSA-72gq-2gg3-2vqq): `X-Owlat-Signature`
 * binds the send timestamp and the delivery id to the body, so a delivery's
 * signature only verifies with the headers it was sent with.
 *
 * The receiver below is the verification example from the Webhooks docs
 * (`apps/docs/content/<locale>/2.api/10.webhooks.md`), written with
 * `node:crypto` rather than the backend's helpers so the test checks the wire
 * contract, not the sender against itself.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SsrfGuard from '../../lib/ssrfGuard';
import { currentAttempt, enqueue, fetchMock, invoke, setup, sentHeaders } from './deliveryHarness';

vi.mock('../../lib/ssrfGuard', async (importOriginal) => ({
	...(await importOriginal<typeof SsrfGuard>()),
	validatePublicUrl: vi.fn(async (url: string) => ({ ok: true, url: new URL(url) })),
	fetchWithGuardedDispatcher: vi.fn(),
}));

const SECRET = 'whsec_test_outbound_signature';
const TOLERANCE_SECONDS = 300;

interface CapturedRequest {
	headers: Record<string, string>;
	body: string;
}

/** The docs' receiver: v1 over `${X-Timestamp}.${X-Webhook-Delivery-Id}.${body}`, then freshness. */
function receiverAccepts(
	request: CapturedRequest,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
	const header = request.headers['X-Owlat-Signature'] ?? '';
	const timestamp = request.headers['X-Timestamp'] ?? '';
	const deliveryId = request.headers['X-Webhook-Delivery-Id'] ?? '';
	const fields = new Map(
		header.split(',').map((part) => {
			const eq = part.indexOf('=');
			return [part.slice(0, eq), part.slice(eq + 1)] as const;
		})
	);
	const v1 = fields.get('v1');
	if (!v1 || !/^\d+$/.test(timestamp) || fields.get('t') !== timestamp || !deliveryId) {
		return false;
	}
	const expected = createHmac('sha256', secret)
		.update(`${timestamp}.${deliveryId}.${request.body}`)
		.digest('hex');
	const presented = Buffer.from(v1, 'hex');
	const wanted = Buffer.from(expected, 'hex');
	if (presented.length !== wanted.length || !timingSafeEqual(presented, wanted)) return false;
	return Math.abs(nowSeconds - Number(timestamp)) <= TOLERANCE_SECONDS;
}

async function captureDelivery(): Promise<CapturedRequest & { logId: string }> {
	const { t, webhookId } = await setup({ secret: SECRET });
	const logId = await enqueue(t, webhookId);
	await invoke(t, await currentAttempt(t, logId));
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [, init] = fetchMock.mock.calls[0]!;
	return {
		logId,
		headers: { ...sentHeaders()[0] },
		body: String(init?.body),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => new Response('ok', { status: 200 }));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('X-Owlat-Signature', () => {
	it('carries t=<X-Timestamp>,v1=<hex> and verifies as sent', async () => {
		const request = await captureDelivery();

		expect(request.headers['X-Owlat-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(request.headers['X-Owlat-Signature']).toContain(`t=${request.headers['X-Timestamp']},`);
		expect(request.headers['X-Webhook-Delivery-Id']).toBe(request.logId);
		expect(receiverAccepts(request, SECRET)).toBe(true);
	});

	it('fails to verify once X-Timestamp is changed', async () => {
		const request = await captureDelivery();
		expect(receiverAccepts(request, SECRET)).toBe(true);

		const later = String(Number(request.headers['X-Timestamp']) + 3600);

		expect(
			receiverAccepts({ ...request, headers: { ...request.headers, 'X-Timestamp': later } }, SECRET)
		).toBe(false);

		// Rewriting the timestamp inside the signature header as well does not help:
		// the timestamp is part of the signed string.
		const rewritten = request.headers['X-Owlat-Signature']!.replace(/^t=\d+/, `t=${later}`);
		expect(
			receiverAccepts(
				{
					...request,
					headers: { ...request.headers, 'X-Timestamp': later, 'X-Owlat-Signature': rewritten },
				},
				SECRET,
				Number(later)
			)
		).toBe(false);
	});

	it('fails to verify once X-Webhook-Delivery-Id is changed', async () => {
		const request = await captureDelivery();
		expect(receiverAccepts(request, SECRET)).toBe(true);

		expect(
			receiverAccepts(
				{
					...request,
					headers: { ...request.headers, 'X-Webhook-Delivery-Id': 'another-delivery' },
				},
				SECRET
			)
		).toBe(false);
	});

	it('fails to verify once the body is changed or under another secret', async () => {
		const request = await captureDelivery();
		expect(receiverAccepts(request, SECRET)).toBe(true);

		expect(receiverAccepts({ ...request, body: `${request.body} ` }, SECRET)).toBe(false);
		expect(receiverAccepts(request, 'whsec_some_other_secret')).toBe(false);
	});

	it('is rejected as stale outside the freshness window', async () => {
		const request = await captureDelivery();
		const sentAt = Number(request.headers['X-Timestamp']);

		expect(receiverAccepts(request, SECRET, sentAt + TOLERANCE_SECONDS)).toBe(true);
		expect(receiverAccepts(request, SECRET, sentAt + TOLERANCE_SECONDS + 1)).toBe(false);
	});

	it('keeps the deprecated body-only X-Signature for existing receivers', async () => {
		const request = await captureDelivery();

		expect(request.headers['X-Signature']).toBe(
			createHmac('sha256', SECRET).update(request.body).digest('hex')
		);
	});
});
