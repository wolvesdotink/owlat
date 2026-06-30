import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookAdapter, type OutboundMessage } from '../index';

const baseMessage: OutboundMessage = {
	contactId: 'c1',
	channel: 'generic',
	content: { text: 'hi' },
};

// =============================================================================
// Bucket 1 — send(): network result mapping (mock global fetch)
// =============================================================================
describe('WebhookAdapter — send()', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns success on a 2xx response', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 });
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in', secret: 's3cret' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://hook.example/in');
		expect(init.method).toBe('POST');
		expect(init.headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(init.body as string);
		expect(body.contactId).toBe('c1');
		expect(body.content).toEqual({ text: 'hi' });
	});

	it('returns an error on a non-2xx response with the HTTP status', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 502 });
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in', secret: 's3cret' });

		const result = await adapter.send(baseMessage);

		expect(result.success).toBe(false);
		expect(result.error).toBe('HTTP 502');
	});

	it('surfaces a thrown fetch error as a failed result', async () => {
		fetchMock.mockRejectedValue(new Error('network down'));
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in', secret: 's3cret' });

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
});

// =============================================================================
// Bucket 2 — parseInbound(): field-layout normalization
// =============================================================================
describe('WebhookAdapter — parseInbound()', () => {
	const adapter = new WebhookAdapter();

	it('prefers `from` over `sender`', () => {
		const parsed = adapter.parseInbound({ from: 'a@x', sender: 'b@x', text: 'hi' });
		expect(parsed.from).toBe('a@x');
	});

	it('falls back to `sender` when `from` is absent', () => {
		const parsed = adapter.parseInbound({ sender: 'b@x', text: 'hi' });
		expect(parsed.from).toBe('b@x');
	});

	it('defaults `from` to "webhook" when neither is present', () => {
		const parsed = adapter.parseInbound({ text: 'hi' });
		expect(parsed.from).toBe('webhook');
	});

	it('text source precedence: text > message > content.text', () => {
		expect(
			adapter.parseInbound({ text: 't', message: 'm', content: { text: 'c' } }).content.text,
		).toBe('t');
		expect(adapter.parseInbound({ message: 'm', content: { text: 'c' } }).content.text).toBe('m');
		expect(adapter.parseInbound({ content: { text: 'c' } }).content.text).toBe('c');
	});

	it('reads html and subject from top-level fields, falling back to content.*', () => {
		const topLevel = adapter.parseInbound({
			from: 'a@x',
			html: '<p>top</p>',
			subject: 'Top',
		});
		expect(topLevel.content.html).toBe('<p>top</p>');
		expect(topLevel.content.subject).toBe('Top');

		const nested = adapter.parseInbound({
			from: 'a@x',
			content: { html: '<p>nested</p>', subject: 'Nested' },
		});
		expect(nested.content.html).toBe('<p>nested</p>');
		expect(nested.content.subject).toBe('Nested');
	});

	it('prefers `id` over `messageId` for externalMessageId', () => {
		expect(adapter.parseInbound({ from: 'a@x', id: 'id-1', messageId: 'mid-1' }).externalMessageId).toBe(
			'id-1',
		);
		expect(adapter.parseInbound({ from: 'a@x', messageId: 'mid-1' }).externalMessageId).toBe('mid-1');
	});

	it('passes through timestamp and metadata, defaulting metadata to {}', () => {
		const withMeta = adapter.parseInbound({
			from: 'a@x',
			timestamp: 1700000000000,
			metadata: { region: 'eu' },
		});
		expect(withMeta.timestamp).toBe(1700000000000);
		expect(withMeta.metadata).toEqual({ region: 'eu' });

		const noMeta = adapter.parseInbound({ from: 'a@x' });
		expect(noMeta.metadata).toEqual({});
		expect(typeof noMeta.timestamp).toBe('number');
	});
});

// =============================================================================
// Bucket 3 — getDeliveryStatus()
// =============================================================================
describe('WebhookAdapter — getDeliveryStatus()', () => {
	it("returns 'sent' for any external id", async () => {
		const adapter = new WebhookAdapter();
		await expect(adapter.getDeliveryStatus('whatever')).resolves.toBe('sent');
	});
});

// =============================================================================
// Bucket 4 — validateSignature(): constant-time secret comparison
//
// The generic webhook now compares the provided header against the configured
// secret, not a mere presence check. Lock that contract down.
// =============================================================================
describe('WebhookAdapter — validateSignature()', () => {
	const secret = 'super-secret-token';

	function configured(): WebhookAdapter {
		const adapter = new WebhookAdapter();
		adapter.configure({ outboundUrl: 'https://hook.example/in', secret });
		return adapter;
	}

	it('returns true for the correct secret in x-webhook-secret', async () => {
		const adapter = configured();
		await expect(adapter.validateSignature({ 'x-webhook-secret': secret }, '{}')).resolves.toBe(true);
	});

	it('returns true for the correct secret in the authorization header', async () => {
		const adapter = configured();
		await expect(adapter.validateSignature({ authorization: secret }, '{}')).resolves.toBe(true);
	});

	it('returns false for a wrong secret (same length)', async () => {
		const adapter = configured();
		// Same length as the secret so the comparison runs the full byte loop.
		const wrong = 'super-secret-WRONG'.slice(0, secret.length);
		expect(wrong.length).toBe(secret.length);
		await expect(adapter.validateSignature({ 'x-webhook-secret': wrong }, '{}')).resolves.toBe(false);
	});

	it('returns false for a wrong secret (different length)', async () => {
		const adapter = configured();
		await expect(adapter.validateSignature({ 'x-webhook-secret': 'nope' }, '{}')).resolves.toBe(false);
	});

	it('returns false when no secret header is present', async () => {
		const adapter = configured();
		await expect(adapter.validateSignature({ 'content-type': 'application/json' }, '{}')).resolves.toBe(
			false,
		);
	});

	it('returns false when unconfigured even if the header carries a value', async () => {
		const adapter = new WebhookAdapter();
		await expect(adapter.validateSignature({ 'x-webhook-secret': secret }, '{}')).resolves.toBe(false);
	});
});
