import { describe, it, expect, vi, beforeEach } from 'vitest';

// The outbound POST now goes through the SSRF guard, so the socket (fetchGuarded)
// is mocked — the real guard would do live DNS on the example host. The shape
// gate (validateConnectedAppEndpoint) stays REAL so its https/credential rules
// are exercised end-to-end.
const guard = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));
vi.mock('../../../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../../../lib/ssrfGuard')),
	fetchGuarded: guard.fetchGuarded,
}));

const { WebhookAdapter } = await import('../index');
type OutboundMessage = import('../index').OutboundMessage;

const baseMessage: OutboundMessage = {
	contactId: 'c1',
	channel: 'generic',
	content: { text: 'hi' },
};

// =============================================================================
// Bucket 1 — send(): network result mapping (mock fetchGuarded)
// =============================================================================
describe('WebhookAdapter — send()', () => {
	const fetchMock = guard.fetchGuarded;

	beforeEach(() => {
		fetchMock.mockReset();
	});

	it('returns success on a 2xx response', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 });
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://hook.example/in');
		expect(init.method).toBe('POST');
		// Content-Type and nothing else. The generic channel collects no secret
		// any more (D10 removed the form field with the caller-less verifier it
		// fed), and the shipped inbound verifier reads GENERIC_WEBHOOK_SECRET.
		// Signing the outbound POST would be a new wire behaviour, not a
		// refactor — so this pins the header set until someone decides
		// otherwise on purpose.
		expect(Object.keys(init.headers)).toEqual(['Content-Type']);
		expect(init.headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(init.body as string);
		expect(body.contactId).toBe('c1');
		expect(body.content).toEqual({ text: 'hi' });
	});

	it('returns an error on a non-2xx response with the HTTP status', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 502 });
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toBe('HTTP 502');
	});

	it('surfaces a thrown fetch error as a failed result', async () => {
		fetchMock.mockRejectedValue(new Error('network down'));
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toBe('network down');
	});

	it('reports a clear error and never calls fetch when unconfigured', async () => {
		const adapter = new WebhookAdapter();

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not configured/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('routes the POST through the SSRF guard (never a raw fetch)', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 });
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in' });

		await adapter.send(baseMessage);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0]!;
		// https pinned + a hard timeout so a hung endpoint can't stall the send.
		expect(init.protocols).toEqual(['https:']);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('rejects a non-https outbound URL before any network call', async () => {
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'http://hook.example/in' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/https/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an outbound URL that embeds credentials before any network call', async () => {
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://user:pass@hook.example/in' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/credential/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('maps a guard SSRF block to a failed result', async () => {
		const { SsrfBlockedError } = await import('../../../lib/ssrfGuard');
		fetchMock.mockRejectedValue(new SsrfBlockedError('blocked: private address'));
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/blocked/i);
	});
});

// =============================================================================
// Bucket 2 — getDeliveryStatus()
// =============================================================================
describe('WebhookAdapter — getDeliveryStatus()', () => {
	it("returns 'sent' for any external id", async () => {
		const adapter = new WebhookAdapter();
		await expect(adapter.getDeliveryStatus('whatever')).resolves.toBe('sent');
	});
});
