import { describe, it, expect } from 'vitest';
import {
	SmsAdapter,
	WhatsAppAdapter,
	WebhookAdapter,
	type ChannelAdapter,
	type ChannelHealth,
	type OutboundMessage,
} from '../index';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapters = {
	sms: new SmsAdapter(),
	whatsapp: new WhatsAppAdapter(),
	generic: new WebhookAdapter(),
} satisfies Record<string, ChannelAdapter>;

/**
 * Every `.ts` module in the adapter folder, enumerated from disk rather than
 * listed here — a new sibling (`telegram.ts`) must be *covered* by the
 * source-text guards below, not silently skipped by them.
 */
const ADAPTER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterSourceFiles = readdirSync(ADAPTER_DIR, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
	.map((entry) => entry.name)
	.sort();

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

	// The map above is hand-written, so on its own it can only prove that what
	// it lists is real — not that it lists everything. Pin the folder contents
	// against it: a new `telegram.ts` fails here and its author has to decide,
	// deliberately, whether it is an adapter (add it to the map, and to the
	// dispatch switch in channels/outbound.ts) or something else entirely.
	it('has no adapter module the map above does not cover', () => {
		expect(adapterSourceFiles).toEqual([
			'index.ts',
			'sms.ts',
			'types.ts',
			'webhook.ts',
			'whatsapp.ts',
		]);
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
		// Enumerated from disk: a module added after this test was written is
		// covered automatically, which is the whole point — the regression this
		// guards against is a *new* adapter re-growing the deleted half.
		expect(adapterSourceFiles.length).toBeGreaterThan(0);
		for (const file of adapterSourceFiles) {
			const source = readFileSync(resolve(ADAPTER_DIR, file), 'utf8');
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
// Bucket 3b — A health probe reports only what its consumer can persist
//
// `probeChannelHealth` (channels/outbound.ts) forwards the result straight to
// `unifiedMessages.updateChannelHealth`, whose arguments are exactly
// `healthStatus` + `lastError`. The shape used to declare `lastSuccessfulSend`,
// `rateLimitRemaining` and `latencyMs` too — the first two never set by any
// adapter, the third measured on every 5-minute probe and then discarded. D10
// dropped all three; this keeps a member nobody reads from creeping back.
//
// `apps/api`'s knip entry glob covers every file under `convex/`, so an unused
// member here is invisible to the dead-code ratchet. This test is the ratchet.
// =============================================================================
describe('channel adapters — ChannelHealth carries nothing unread', () => {
	// Compile-time exhaustiveness, same trick as the contract methods above: a
	// new member on `ChannelHealth` fails to build here until it is listed, and
	// listing it fails the runtime assertion until updateChannelHealth can
	// actually store it.
	const HEALTH_FIELDS: Record<keyof ChannelHealth, true> = { status: true, lastError: true };

	it('declares exactly the fields updateChannelHealth persists', () => {
		expect(Object.keys(HEALTH_FIELDS).sort()).toEqual(['lastError', 'status']);
	});

	it('no adapter returns a health field beyond that set', async () => {
		for (const [name, adapter] of Object.entries(adapters)) {
			const health = await adapter.healthCheck();
			for (const key of Object.keys(health)) {
				expect(
					key in HEALTH_FIELDS,
					`${name} adapter reports ${key}, which updateChannelHealth cannot store`
				).toBe(true);
			}
		}
	});
});

// =============================================================================
// Bucket 4 — Extension proof: the contract is implementable from outside
//
// A replacement provider for a dispatchable channel — a different HTTP relay
// behind `generic`, say — satisfies `ChannelAdapter` by structural typing
// alone, with no base class and no registration. Note the id is deliberately a
// dispatchable channel: `ChannelAdapter.id` is `OutboundChannel`, so an adapter
// claiming `email` or `chat` does not compile (see types.ts). That is the
// folder's stated invariant enforced by the type checker rather than by the
// hand-written map in bucket 1.
// =============================================================================
describe('channel adapters — extension proof', () => {
	it('a third-party ChannelAdapter satisfies the interface and integrates by structural typing', async () => {
		const relayLike: ChannelAdapter = {
			id: 'generic',
			async send() {
				return { success: true, externalMessageId: 'relay-1' };
			},
			async getDeliveryStatus() {
				return 'delivered';
			},
			async healthCheck() {
				return { status: 'healthy' };
			},
		};

		const result = await relayLike.send({
			contactId: 'c1',
			channel: 'generic',
			content: { text: 'hi' },
		});
		expect(result.success).toBe(true);
		expect(result.externalMessageId).toBe('relay-1');
	});

	// The non-dispatchable half of the same rule. `email` and `chat` are
	// `UnifiedMessageChannel` members with no adapter here on purpose, and
	// `ChannelAdapter.id` excludes them — this pins that the exclusion is a
	// compile error, not just a comment.
	it('rejects an adapter claiming a non-dispatchable channel at compile time', () => {
		const emailLike: ChannelAdapter = {
			// @ts-expect-error `email` is owned by the send-provider seam, so it is
			// not an `OutboundChannel` and cannot be a ChannelAdapter id.
			id: 'email',
			async send() {
				return { success: true };
			},
			async getDeliveryStatus() {
				return 'delivered' as const;
			},
			async healthCheck() {
				return { status: 'healthy' as const };
			},
		};
		expect(emailLike.id).toBe('email');
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
