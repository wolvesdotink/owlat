import { describe, it, expect } from 'vitest';
import {
	SmsAdapter,
	WhatsAppAdapter,
	WebhookAdapter,
	type ChannelAdapter,
	type OutboundMessage,
} from '../index';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapters = {
	sms: new SmsAdapter(),
	whatsapp: new WhatsAppAdapter(),
	generic: new WebhookAdapter(),
} satisfies Record<string, ChannelAdapter>;

// =============================================================================
// Bucket 1 — Unit: instantiation
// =============================================================================
describe('channel adapters — instantiation', () => {
	it('every adapter exposes its declared id', () => {
		expect(adapters.sms.id).toBe('sms');
		expect(adapters.whatsapp.id).toBe('whatsapp');
		expect(adapters.generic.id).toBe('generic');
	});

	// The set is closed on purpose: `email` is dispatched by the send-provider
	// seam and `chat` is persisted natively, so neither has (or had) a working
	// adapter here. The two classes that pretended otherwise were deleted with
	// the D10 honesty pass; this pins the surface so they cannot creep back.
	it('covers exactly the operator-configurable outbound channels', () => {
		expect(Object.keys(adapters).sort()).toEqual(['generic', 'sms', 'whatsapp']);
	});
});

// =============================================================================
// Bucket 2 — Contract: every adapter honours ChannelAdapter
// =============================================================================
describe('channel adapters — ChannelAdapter contract', () => {
	for (const [name, adapter] of Object.entries(adapters)) {
		describe(`${name}`, () => {
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
// Bucket 3 — The surface is OUTBOUND ONLY
//
// The contract used to carry `parseInbound` and `validateSignature`, and no
// host path ever called either: the shipped inbound route verifies and parses
// through `webhooks/adapters/{twilio,meta,generic}.ts`. Keeping a second copy
// meant a Twilio field change or a `Bearer ` prefix rule could be fixed in one
// place and silently missed in the other — and they had already drifted. D10
// deleted the caller-less half; this bucket keeps it deleted, at the type
// level (the interface would not compile with a stray member — see the
// exhaustive literal below), at runtime, and in the source text.
// =============================================================================
describe('channel adapters — outbound-only surface', () => {
	const INBOUND_ONLY_MEMBERS = ['parseInbound', 'validateSignature'] as const;

	// Compile-time exhaustiveness: `Record<ContractMethod, true>` fails to build
	// if a member is added to `ChannelAdapter` and not listed here (missing key)
	// or listed and not on the interface (excess property). So the runtime
	// assertion below cannot silently stop covering the whole contract.
	type ContractMethod = Exclude<keyof ChannelAdapter, 'id'>;
	const CONTRACT_METHODS: Record<ContractMethod, true> = {
		send: true,
		getDeliveryStatus: true,
		healthCheck: true,
	};

	it('implements exactly the contract the outbound action calls', () => {
		expect(Object.keys(CONTRACT_METHODS).sort()).toEqual([
			'getDeliveryStatus',
			'healthCheck',
			'send',
		]);
		for (const [name, adapter] of Object.entries(adapters)) {
			for (const method of Object.keys(CONTRACT_METHODS)) {
				expect(
					typeof (adapter as unknown as Record<string, unknown>)[method],
					`${name} adapter is missing ${method}`
				).toBe('function');
			}
		}
	});

	it('carries no inbound verification or parsing member at runtime', () => {
		for (const [name, adapter] of Object.entries(adapters)) {
			for (const member of INBOUND_ONLY_MEMBERS) {
				expect(
					member in (adapter as unknown as Record<string, unknown>),
					`${name} adapter must not re-grow ${member} — extend webhooks/adapters/ instead`
				).toBe(false);
			}
		}
	});

	it('never names an inbound member anywhere in the adapter sources', () => {
		const adapterDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
		for (const file of ['types.ts', 'index.ts', 'sms.ts', 'whatsapp.ts', 'webhook.ts']) {
			const source = readFileSync(resolve(adapterDir, file), 'utf8');
			// Strip comments: the header notes deliberately explain why the pair
			// is gone, and that prose must stay readable.
			const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
			for (const member of INBOUND_ONLY_MEMBERS) {
				expect(code, `${file} re-declares ${member}`).not.toContain(member);
			}
		}
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
			async getDeliveryStatus() {
				return 'delivered';
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
			(a) => a.getDeliveryStatus('SM1')
		);
		expect(status).toBe('sent');
	});

	it('reports `sent` (not `failed`) on a 5xx response', async () => {
		const status = await withFetch(
			(async () => new Response('boom', { status: 503 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1')
		);
		expect(status).toBe('sent');
	});

	it('reports `sent` (not `failed`) on a network/parse error', async () => {
		const status = await withFetch(
			(async () => {
				throw new Error('ETIMEDOUT');
			}) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1')
		);
		expect(status).toBe('sent');
	});

	it('maps a confirmed Twilio `failed` status to `failed`', async () => {
		const status = await withFetch(
			(async () =>
				new Response(JSON.stringify({ status: 'failed' }), { status: 200 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1')
		);
		expect(status).toBe('failed');
	});

	it('maps a confirmed Twilio `undelivered` status to `failed`', async () => {
		const status = await withFetch(
			(async () =>
				new Response(JSON.stringify({ status: 'undelivered' }), { status: 200 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1')
		);
		expect(status).toBe('failed');
	});

	it('maps a confirmed Twilio `delivered` status to `delivered`', async () => {
		const status = await withFetch(
			(async () =>
				new Response(JSON.stringify({ status: 'delivered' }), { status: 200 })) as typeof fetch,
			(a) => a.getDeliveryStatus('SM1')
		);
		expect(status).toBe('delivered');
	});
});
