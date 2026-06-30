import { describe, it, expect } from 'vitest';
import {
	EmailAdapter,
	SmsAdapter,
	WhatsAppAdapter,
	WebhookAdapter,
	ChatAdapter,
	type ChannelAdapter,
	type OutboundMessage,
	type ParsedMessage,
} from '../index';

const adapters = {
	email: new EmailAdapter(),
	sms: new SmsAdapter(),
	whatsapp: new WhatsAppAdapter(),
	generic: new WebhookAdapter(),
	chat: new ChatAdapter(),
} satisfies Record<string, ChannelAdapter>;

// =============================================================================
// Bucket 1 — Unit: instantiation
// =============================================================================
describe('channel adapters — instantiation', () => {
	it('every adapter exposes its declared id', () => {
		expect(adapters.email.id).toBe('email');
		expect(adapters.sms.id).toBe('sms');
		expect(adapters.whatsapp.id).toBe('whatsapp');
		expect(adapters.generic.id).toBe('generic');
		expect(adapters.chat.id).toBe('chat');
	});
});

// =============================================================================
// Bucket 2 — Contract: every adapter honours ChannelAdapter
// =============================================================================
describe('channel adapters — ChannelAdapter contract', () => {
	for (const [name, adapter] of Object.entries(adapters)) {
		describe(`${name}`, () => {
			it('implements every ChannelAdapter method', () => {
				expect(typeof adapter.send).toBe('function');
				expect(typeof adapter.parseInbound).toBe('function');
				expect(typeof adapter.getDeliveryStatus).toBe('function');
				expect(typeof adapter.validateSignature).toBe('function');
				expect(typeof adapter.healthCheck).toBe('function');
			});

			it('returns a SendResult with success boolean from send()', async () => {
				const msg: OutboundMessage = {
					contactId: 'c1',
					channel: adapter.id,
					content: { text: 'hi' },
				};
				const result = await adapter.send(msg);
				expect(typeof result.success).toBe('boolean');
			});
		});
	}
});

// =============================================================================
// Bucket 3 — Behavior-parity / regression
//
// The adapter file contents were moved verbatim from
// apps/api/convex/lib/channels/. parseInbound's normalization shape is
// stable: we lock the chat and webhook parsers to known input/output
// pairs so a careless edit can't drift the public contract.
// =============================================================================
describe('channel adapters — parseInbound parity', () => {
	it('chat parser extracts userId and text', () => {
		const parsed: ParsedMessage = adapters.chat.parseInbound({
			userId: 'u1',
			text: 'hello world',
			messageId: 'msg-1',
		});
		expect(parsed.from).toBe('u1');
		expect(parsed.content.text).toBe('hello world');
		expect(parsed.externalMessageId).toBe('msg-1');
	});

	it('generic-webhook parser handles the canonical { from, text } payload', () => {
		const parsed = adapters.generic.parseInbound({
			from: 'webhook-source',
			text: 'inbound text',
		});
		expect(parsed.from).toBe('webhook-source');
		expect(parsed.content.text).toBe('inbound text');
	});

	it('sms parser maps Twilio fields (From, Body, MessageSid)', () => {
		const parsed = adapters.sms.parseInbound({
			From: '+15551234',
			Body: 'sms body',
			MessageSid: 'SM-abc',
		});
		expect(parsed.from).toBe('+15551234');
		expect(parsed.content.text).toBe('sms body');
		expect(parsed.externalMessageId).toBe('SM-abc');
	});
});

// =============================================================================
// Bucket 4 — Extension proof: the interface accepts a new channel
// =============================================================================
describe('channel adapters — extension proof', () => {
	it('a third-party ChannelAdapter satisfies the interface and integrates by structural typing', async () => {
		const slackLike: ChannelAdapter = {
			id: 'chat',
			async send() {
				return { success: true, externalMessageId: 'slack-1' };
			},
			parseInbound: (raw) => ({
				from: (raw as { user?: string }).user ?? 'unknown',
				content: { text: (raw as { text?: string }).text ?? '' },
				timestamp: Date.now(),
			}),
			async getDeliveryStatus() {
				return 'delivered';
			},
			async validateSignature() {
				return true;
			},
			async healthCheck() {
				return { status: 'healthy' };
			},
		};

		const result = await slackLike.send({
			contactId: 'c1',
			channel: 'chat',
			content: { text: 'hi' },
		});
		expect(result.success).toBe(true);
		expect(result.externalMessageId).toBe('slack-1');
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('channel adapters — failure modes', () => {
	it('unconfigured SMS adapter reports a clear send error', async () => {
		const adapter = new SmsAdapter();
		const result = await adapter.send({
			contactId: 'c1',
			channel: 'sms',
			content: { text: 'hi' },
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not configured/i);
	});

	it('unconfigured WhatsApp adapter reports a clear send error', async () => {
		const adapter = new WhatsAppAdapter();
		const result = await adapter.send({
			contactId: 'c1',
			channel: 'whatsapp',
			content: { text: 'hi' },
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not configured/i);
	});

	it('unconfigured webhook adapter reports a clear send error', async () => {
		const adapter = new WebhookAdapter();
		const result = await adapter.send({
			contactId: 'c1',
			channel: 'generic',
			content: { text: 'hi' },
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not configured/i);
	});

	it('unconfigured SMS adapter healthCheck reports down', async () => {
		const health = await new SmsAdapter().healthCheck();
		expect(health.status).toBe('down');
	});
});

describe('SmsAdapter.getDeliveryStatus — transient vs terminal', () => {
	const configure = () => {
		const adapter = new SmsAdapter();
		adapter.configure({ accountSid: 'AC123', authToken: 'tok', fromNumber: '+1555' });
		return adapter;
	};

	const withFetch = async (impl: typeof fetch, run: (a: SmsAdapter) => Promise<unknown>) => {
		const original = globalThis.fetch;
		globalThis.fetch = impl;
		try {
			return await run(configure());
		} finally {
			globalThis.fetch = original;
		}
	};

	it('reports the no-change sentinel (sent), not failed, when unconfigured', async () => {
		// `failed` is a forward transition for the poller; an unconfigured lookup
		// must never mis-mark a delivered message.
		expect(await new SmsAdapter().getDeliveryStatus('SM1')).toBe('sent');
	});

	it('reports `sent` (not `failed`) on a transient non-2xx response', async () => {
		const status = await withFetch(
			(async () => new Response('rate limited', { status: 429 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1'),
		);
		expect(status).toBe('sent');
	});

	it('reports `sent` (not `failed`) on a 5xx response', async () => {
		const status = await withFetch(
			(async () => new Response('boom', { status: 503 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1'),
		);
		expect(status).toBe('sent');
	});

	it('reports `sent` (not `failed`) on a network/parse error', async () => {
		const status = await withFetch(
			(async () => {
				throw new Error('ETIMEDOUT');
			}) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1'),
		);
		expect(status).toBe('sent');
	});

	it('maps a confirmed Twilio `failed` status to `failed`', async () => {
		const status = await withFetch(
			(async () => new Response(JSON.stringify({ status: 'failed' }), { status: 200 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1'),
		);
		expect(status).toBe('failed');
	});

	it('maps a confirmed Twilio `undelivered` status to `failed`', async () => {
		const status = await withFetch(
			(async () => new Response(JSON.stringify({ status: 'undelivered' }), { status: 200 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1'),
		);
		expect(status).toBe('failed');
	});

	it('maps a confirmed Twilio `delivered` status to `delivered`', async () => {
		const status = await withFetch(
			(async () => new Response(JSON.stringify({ status: 'delivered' }), { status: 200 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1'),
		);
		expect(status).toBe('delivered');
	});
});
