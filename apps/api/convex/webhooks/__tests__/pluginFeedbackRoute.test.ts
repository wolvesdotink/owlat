/**
 * THE PLUGIN FEEDBACK ROUTE, ADVERSARIALLY (the seams plan's D6, wired by
 * P2.2).
 *
 * `/webhooks/plugin/<pluginId>` is the only unauthenticated, internet-facing
 * write path the plugin platform has, and everything behind it — suppression
 * lists, send lifecycle transitions, the measurement plane's per-arm counters —
 * is state an attacker would like to move. So this suite is written from the
 * attacker's side: each case is a request a hostile caller can actually make,
 * and the assertion is that it changes NOTHING.
 *
 *   unknown plugin id     → 404 before a byte of the body is read
 *   forged signature      → 401, no dispatch, no audit row, no claim
 *   missing/stale/future timestamp → 401 (a captured request cannot be parked)
 *   unset signing secret  → 503, never a pass
 *   replayed delivery     → 409, dispatched exactly once
 *   revoked grant / off   → 403, and the claim is never taken
 *   oversized body        → 413 on the declared length, or on the real bytes
 *   dishonest parse output→ 400, whole batch refused, claim released, audited
 *   an over-limit batch   → 413 naming the limit, so the operator can chunk
 *
 * plus the positive properties the negatives would be meaningless without: a
 * correctly signed, authorized delivery IS dispatched with the host's own
 * provider attribution, and raw retention happens exactly where the adapter
 * asked for it — both branches of that opt-in, since the write is a silent one.
 *
 * The dispatcher is mocked deliberately — it has its own suites, and what is
 * under test here is the gate sequence, not what an inbound event does after it
 * has passed every gate.
 */

import { createHmac } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted with the mock factories: `vi.mock` runs before the module body, so
// the fixture the factories close over has to be built there too.
const fixture = vi.hoisted(() => {
	const kind = 'plugin.mail-pack.postmark';
	return {
		parseEvents: vi.fn(),
		dispatch: vi.fn(),
		kind,
		pluginId: 'mail-pack',
		secretEnv: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
		secret: 'a-shared-signing-secret',
		signatureHeader: 'x-postmark-signature',
		timestampHeader: 'x-postmark-timestamp',
		toleranceSeconds: 300,
		// A SECOND bundled plugin, identical but for the one flag under test:
		// `storeRawPayload` is baked into the composed catalog, so the opt-in's
		// other branch can only be reached by a second adapter that asked for it.
		retention: {
			parseEvents: vi.fn(),
			kind: 'plugin.keep-pack.audit',
			pluginId: 'keep-pack',
			localId: 'audit',
			secretEnv: 'PLUGIN_KEEP_WEBHOOK_SECRET',
			secret: 'the-other-signing-secret',
		},
	};
});

const mocks = fixture;
const {
	kind: KIND,
	pluginId: PLUGIN_ID,
	secretEnv: SECRET_ENV,
	secret: SECRET,
	signatureHeader: SIGNATURE_HEADER,
	timestampHeader: TIMESTAMP_HEADER,
	toleranceSeconds: TOLERANCE_SECONDS,
} = fixture;

vi.mock('../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: fixture.kind,
			pluginId: fixture.pluginId,
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
		Object.freeze({
			kind: fixture.retention.kind,
			pluginId: fixture.retention.pluginId,
			localId: fixture.retention.localId,
			label: 'Keep',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportWebhookCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: Object.freeze([
		Object.freeze({
			kind: fixture.kind,
			pluginId: fixture.pluginId,
			localId: 'postmark',
			signature: Object.freeze({
				header: fixture.signatureHeader,
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: fixture.secretEnv,
				replay: Object.freeze({
					timestampHeader: fixture.timestampHeader,
					toleranceSeconds: fixture.toleranceSeconds,
				}),
			}),
			storeRawPayload: false,
			requiredCapability: 'send:transport',
		}),
		Object.freeze({
			kind: fixture.retention.kind,
			pluginId: fixture.retention.pluginId,
			localId: fixture.retention.localId,
			signature: Object.freeze({
				header: fixture.signatureHeader,
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				// Its own variable: the host refuses two bundled webhooks that share
				// one, because a body signed for either would verify at both routes.
				secretEnvVar: fixture.retention.secretEnv,
				replay: Object.freeze({
					timestampHeader: fixture.timestampHeader,
					toleranceSeconds: fixture.toleranceSeconds,
				}),
			}),
			storeRawPayload: true,
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportWebhookModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: Object.freeze([
		Object.freeze({
			kind: fixture.kind,
			pluginId: fixture.pluginId,
			module: { parseEvents: (raw: string) => fixture.parseEvents(raw) as unknown },
		}),
		Object.freeze({
			kind: fixture.retention.kind,
			pluginId: fixture.retention.pluginId,
			module: { parseEvents: (raw: string) => fixture.retention.parseEvents(raw) as unknown },
		}),
	]),
}));

vi.mock('../dispatcher', () => ({
	dispatchInboundEvent: (...args: unknown[]) => fixture.dispatch(...args) as unknown,
}));

import { pluginFeedbackWebhook } from '../pluginFeedbackHttp';
import { MAX_PLUGIN_FEEDBACK_EVENTS } from '../pluginFeedbackEvents';

type HttpHandler = (ctx: unknown, request: Request) => Promise<Response>;
const handler = (pluginFeedbackWebhook as unknown as { _handler: HttpHandler })._handler;

interface ContextOptions {
	readonly isRateLimited?: boolean;
	readonly isAuthorized?: boolean;
	readonly isClaimable?: boolean;
	readonly isStorable?: boolean;
}

function fakeContext(options: ContextOptions = {}) {
	const calls: string[] = [];
	const scheduled: { name: string; args: Record<string, unknown> }[] = [];
	const stored: Record<string, unknown>[] = [];
	const ctx = {
		runMutation: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(reference as never);
			calls.push(name);
			if (name.includes('checkPublicRateLimit')) {
				return { ok: options.isRateLimited !== true, retryAfter: 1_000 };
			}
			if (name.includes('authorizeDelivery')) return options.isAuthorized !== false;
			if (name.includes('pluginFeedbackDeliveries:claim')) return options.isClaimable !== false;
			if (name.includes('pluginFeedbackDeliveries:release')) return undefined;
			if (name.includes('payloads:store')) {
				if (options.isStorable === false) throw new Error('audit store unavailable');
				stored.push(args);
				return undefined;
			}
			throw new Error(`unexpected mutation ${name}`);
		}),
		scheduler: {
			runAfter: vi.fn(async (_ms: number, reference: unknown, args: Record<string, unknown>) => {
				scheduled.push({ name: getFunctionName(reference as never), args });
			}),
		},
	};
	return { ctx, calls, scheduled, stored };
}

const BODY = JSON.stringify({ events: [{ type: 'bounce', id: 'abc' }] });

function sign(body: string, timestampSeconds: number, secret = SECRET): string {
	return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
}

interface RequestOptions {
	readonly pluginId?: string;
	readonly body?: string;
	readonly timestamp?: string | null;
	readonly signature?: string | null;
	readonly method?: string;
	readonly headers?: Record<string, string>;
	/** The signing secret to use; the addressed plugin's own by default. */
	readonly secret?: string;
}

function webhookRequest(options: RequestOptions = {}): Request {
	const body = options.body ?? BODY;
	const timestampSeconds = Math.floor(Date.now() / 1000);
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...options.headers,
	};
	const timestamp = options.timestamp === undefined ? String(timestampSeconds) : options.timestamp;
	if (timestamp !== null) headers[TIMESTAMP_HEADER] = timestamp;
	const signature =
		options.signature === undefined
			? sign(body, Number(timestamp ?? timestampSeconds), options.secret ?? SECRET)
			: options.signature;
	if (signature !== null) headers[SIGNATURE_HEADER] = signature;
	return new Request(
		`https://example.convex.site/webhooks/plugin/${options.pluginId ?? PLUGIN_ID}`,
		{
			method: options.method ?? 'POST',
			body: options.method === 'GET' ? undefined : body,
			headers,
		}
	);
}

const BOUNCE = Object.freeze({
	kind: 'bounced',
	providerMessageId: 'provider-message-1',
	at: 0,
	bounceType: 'hard',
});

/** The plugin module's honest output for `BODY`, refreshed to "now". */
function bounceEvents() {
	return [{ ...BOUNCE, at: Date.now() }];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	vi.stubEnv(SECRET_ENV, SECRET);
	vi.stubEnv(mocks.retention.secretEnv, mocks.retention.secret);
	mocks.parseEvents.mockImplementation(() => bounceEvents());
	mocks.retention.parseEvents.mockImplementation(() => bounceEvents());
	mocks.dispatch.mockImplementation(async () => undefined);
});

describe('a caller who cannot name a bundled webhook', () => {
	it.each([
		['an unregistered plugin id', { pluginId: 'not-bundled' }],
		['an empty id', { pluginId: '' }],
		['a deeper path', { pluginId: `${PLUGIN_ID}/extra` }],
		// A `Map` lookup, so a prototype key is not a key at all — the mistake that
		// would otherwise hand back an inherited member to be called as an adapter.
		['a prototype key', { pluginId: '__proto__' }],
		['constructor', { pluginId: 'constructor' }],
	] as const)('is refused with 404: %s', async (_label, options) => {
		const { ctx, calls } = fakeContext();
		const response = await handler(ctx, webhookRequest(options));

		expect(response.status).toBe(404);
		// Nothing but the rate-limit token was spent: no signature check (which
		// would be an oracle), no authorization, no claim, no dispatch.
		expect(calls.filter((name) => !name.includes('checkPublicRateLimit'))).toEqual([]);
		expect(mocks.parseEvents).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it('shares ONE rate-limit bucket across every unknown id', async () => {
		// Otherwise walking made-up ids would mint a fresh bucket per guess and the
		// limit would not bound anything.
		const { ctx } = fakeContext();
		await handler(ctx, webhookRequest({ pluginId: 'guess-one' }));
		await handler(ctx, webhookRequest({ pluginId: 'guess-two' }));

		const keys = ctx.runMutation.mock.calls.map((call) => (call[1] as { key: string }).key);
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toContain(':unknown:');
	});

	it('keys a KNOWN plugin under its own bucket', async () => {
		const { ctx } = fakeContext();
		await handler(ctx, webhookRequest());
		const key = (ctx.runMutation.mock.calls[0]![1] as { key: string }).key;
		expect(key).toContain(`plugin:${PLUGIN_ID}:`);
	});

	it('is rate limited before anything else', async () => {
		const { ctx, calls } = fakeContext({ isRateLimited: true });
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(429);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('checkPublicRateLimit');
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it('answers a non-POST without touching the registry', async () => {
		const { ctx, calls } = fakeContext();
		const response = await handler(ctx, webhookRequest({ method: 'GET' }));

		expect(response.status).toBe(405);
		expect(calls).toEqual([]);
	});
});

describe('a caller who cannot produce the signature', () => {
	it.each([
		['a forged signature', { signature: 'f'.repeat(64) }],
		['no signature at all', { signature: null }],
		['an empty signature', { signature: '' }],
		[
			'a signature over the body alone (the pre-replay scheme)',
			{ signature: createHmac('sha256', SECRET).update(BODY).digest('hex') },
		],
		['a signature under another secret', { signature: sign(BODY, 0, 'not-the-secret') }],
	] as const)('is refused with 401: %s', async (_label, options) => {
		const { ctx, calls, scheduled } = fakeContext();
		const response = await handler(ctx, webhookRequest(options));

		expect(response.status).toBe(401);
		// No authorization mutation ran, so a stranger cannot make us write audit
		// rows; no claim was taken, so they cannot deny a real delivery either.
		expect(calls.some((name) => name.includes('authorizeDelivery'))).toBe(false);
		expect(calls.some((name) => name.includes('claim'))).toBe(false);
		expect(scheduled).toEqual([]);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it('rejects a valid signature over a DIFFERENT body', async () => {
		// The body is inside the signed string, so swapping it after signing must
		// not verify — this is what stops a captured signature from being reused to
		// suppress a different recipient.
		const timestamp = Math.floor(Date.now() / 1000);
		const response = await handler(
			fakeContext().ctx,
			webhookRequest({
				body: JSON.stringify({ events: [{ type: 'bounce', id: 'victim' }] }),
				timestamp: String(timestamp),
				signature: sign(BODY, timestamp),
			})
		);
		expect(response.status).toBe(401);
	});

	it('answers 503, never a pass, when the signing secret is unset', async () => {
		vi.stubEnv(SECRET_ENV, '');
		const response = await handler(fakeContext().ctx, webhookRequest());

		expect(response.status).toBe(503);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
});

describe('a caller replaying a request that was once authentic', () => {
	it.each([
		['no timestamp', { timestamp: null }],
		['a non-numeric timestamp', { timestamp: 'yesterday' }],
		['a stale timestamp', { timestamp: String(Math.floor(Date.now() / 1000) - 3_600) }],
		// The far-future case matters as much as the stale one: without it a
		// captured request could be parked and replayed whenever it suited.
		['a far-future timestamp', { timestamp: String(Math.floor(Date.now() / 1000) + 3_600) }],
	] as const)('is refused with 401: %s', async (_label, options) => {
		const timestamp = options.timestamp;
		const signature =
			timestamp === null || !/^\d+$/.test(timestamp) ? null : sign(BODY, Number(timestamp));
		const { ctx } = fakeContext();
		const response = await handler(
			ctx,
			webhookRequest({ timestamp, ...(signature ? { signature } : {}) })
		);

		expect(response.status).toBe(401);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it('is refused with 409 when the delivery digest was already claimed', async () => {
		const { ctx, calls } = fakeContext({ isClaimable: false });
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(409);
		// The whole point: a request that verifies perfectly still applies nothing
		// the second time.
		expect(mocks.parseEvents).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(calls.some((name) => name.includes('claim'))).toBe(true);
	});

	it('claims a digest derived from the signature, so identical bytes collide', async () => {
		const request = webhookRequest();
		const first = fakeContext();
		const second = fakeContext();
		await handler(first.ctx, request.clone());
		await handler(second.ctx, request.clone());

		const digestOf = (context: ReturnType<typeof fakeContext>) =>
			context.ctx.runMutation.mock.calls.find((call) =>
				getFunctionName(call[0] as never).includes('claim')
			)![1] as { deliveryDigest: string; expiresAt: number };

		expect(digestOf(first).deliveryDigest).toBe(digestOf(second).deliveryDigest);
		// Never the signature itself: the claim table is not a place to accumulate
		// live MACs computed under a shared secret.
		expect(digestOf(first).deliveryDigest).not.toContain(
			request.headers.get(SIGNATURE_HEADER) ?? 'unset'
		);
		// The claim outlives the window in which the same request could still
		// verify, and no longer.
		expect(digestOf(first).expiresAt).toBeGreaterThan(Date.now() + TOLERANCE_SECONDS * 1000);
		expect(digestOf(first).expiresAt).toBeLessThanOrEqual(
			Date.now() + 2 * TOLERANCE_SECONDS * 1000
		);
	});

	it('gives the claim back when the delivery could not be applied', async () => {
		// Our failure must not turn the provider's honest redelivery into a
		// "replay" — that would lose the feedback permanently.
		mocks.dispatch.mockRejectedValueOnce(new Error('dispatcher exploded'));
		const { ctx, calls } = fakeContext();
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(500);
		expect(calls.some((name) => name.includes('pluginFeedbackDeliveries:release'))).toBe(true);
	});
});

describe('a delivery whose plugin is no longer allowed to act', () => {
	it('is refused with 403 and never claims a delivery', async () => {
		const { ctx, calls } = fakeContext({ isAuthorized: false });
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(403);
		expect(calls.some((name) => name.includes('claim'))).toBe(false);
		expect(mocks.parseEvents).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it('rechecks authorization on EVERY delivery, not once at composition', async () => {
		const { ctx } = fakeContext();
		await handler(ctx, webhookRequest());
		await handler(ctx, webhookRequest());
		expect(
			ctx.runMutation.mock.calls.filter((call) =>
				getFunctionName(call[0] as never).includes('authorizeDelivery')
			)
		).toHaveLength(2);
	});
});

describe('a plugin module that returns something dishonest', () => {
	it.each([
		['a non-array', { events: [] }],
		['a kind outside the vocabulary', [{ kind: 'email.opened', providerMessageId: 'x', at: 1 }]],
		['a bounce with no message id', [{ kind: 'bounced', at: Date.now(), bounceType: 'hard' }]],
		[
			'a bounce with an invented severity',
			[{ kind: 'bounced', providerMessageId: 'x', at: Date.now(), bounceType: 'catastrophic' }],
		],
		['a complaint naming nobody', [{ kind: 'complained', at: Date.now() }]],
		['a timestamp from the far future', [{ ...BOUNCE, at: Date.now() + 31_536_000_000 }]],
		['an oversized id', [{ ...BOUNCE, at: Date.now(), providerMessageId: 'x'.repeat(2_000) }]],
	] as const)('is refused with 400 and dispatches nothing: %s', async (_label, parsed) => {
		mocks.parseEvents.mockImplementationOnce(() => parsed);
		const { ctx, calls } = fakeContext();
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(400);
		// The WHOLE batch is refused: a half-applied batch is worse than one the
		// provider redelivers, so the claim goes back too.
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(calls.some((name) => name.includes('pluginFeedbackDeliveries:release'))).toBe(true);
	});

	it('audits a refusal, so an operator can see the feedback that never landed', async () => {
		// The failure mode this covers is total: a parse half that is wrong against
		// its provider's real payloads drops 100% of a transport's feedback. Without
		// a row, the Audit Log an operator opens to ask "why are no bounces
		// arriving?" is simply empty.
		mocks.parseEvents.mockImplementationOnce(() => [{ kind: 'combusted', at: Date.now() }]);
		const { ctx, scheduled } = fakeContext();
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(400);
		expect(scheduled).toEqual([
			{
				name: expect.stringContaining('sendTransportWebhookAuthorization:recordOutcome'),
				args: { pluginId: PLUGIN_ID, transportKind: KIND, outcome: 'failed' },
			},
		]);
	});

	it('answers an over-limit batch 413, naming the limit', async () => {
		// Distinguishable from a malformed body ON PURPOSE: from the provider's
		// delivery log both are "our webhook is failing", but only one is fixed by
		// chunking, and the limit is documented so an author can size their batches.
		mocks.parseEvents.mockImplementationOnce(() =>
			Array.from({ length: MAX_PLUGIN_FEEDBACK_EVENTS + 1 }, () => ({
				...BOUNCE,
				at: Date.now(),
			}))
		);
		const { ctx, calls } = fakeContext();
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: `Batch too large: at most ${MAX_PLUGIN_FEEDBACK_EVENTS} events`,
		});
		expect(mocks.dispatch).not.toHaveBeenCalled();
		// Still a delivery that did not happen: the claim goes back, so a chunked
		// redelivery of the same events is not read as a replay.
		expect(calls.some((name) => name.includes('pluginFeedbackDeliveries:release'))).toBe(true);
	});

	it('accepts a batch AT the limit', async () => {
		// The cap is sized to what a real ESP posts inside the body limit, so the
		// boundary must be usable rather than nominally documented.
		mocks.parseEvents.mockImplementationOnce(() =>
			Array.from({ length: MAX_PLUGIN_FEEDBACK_EVENTS }, () => ({ ...BOUNCE, at: Date.now() }))
		);
		const response = await handler(fakeContext().ctx, webhookRequest());

		expect(response.status).toBe(200);
		expect(mocks.dispatch).toHaveBeenCalledTimes(MAX_PLUGIN_FEEDBACK_EVENTS);
	});

	it('refuses a batch whose LAST event is malformed, having dispatched none of it', async () => {
		mocks.parseEvents.mockImplementationOnce(() => [
			{ ...BOUNCE, at: Date.now() },
			{ kind: 'bounced', at: Date.now(), bounceType: 'hard' },
		]);
		const response = await handler(fakeContext().ctx, webhookRequest());

		expect(response.status).toBe(400);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it('refuses an event carried on the prototype rather than the object', async () => {
		mocks.parseEvents.mockImplementationOnce(() => [
			Object.assign(Object.create({ kind: 'bounced' }), {
				providerMessageId: 'x',
				at: Date.now(),
				bounceType: 'hard',
			}),
		]);
		expect((await handler(fakeContext().ctx, webhookRequest())).status).toBe(400);
	});

	it('answers 400 when the module itself throws', async () => {
		mocks.parseEvents.mockImplementationOnce(() => {
			throw new Error('unparseable');
		});
		expect((await handler(fakeContext().ctx, webhookRequest())).status).toBe(400);
	});

	it('cannot attribute its events to another transport', async () => {
		// `providerType` is what the measurement plane grades an arm by. It is
		// stamped by the host from the registry, so a plugin naming somebody else's
		// kind changes nothing.
		mocks.parseEvents.mockImplementationOnce(() => [
			{ ...BOUNCE, at: Date.now(), providerType: 'ses' },
		]);
		const response = await handler(fakeContext().ctx, webhookRequest());

		// The extra field is simply not read: the event is valid, and its
		// attribution is ours.
		expect(response.status).toBe(200);
		expect(mocks.dispatch.mock.calls[0]![1]).toMatchObject({ providerType: KIND });
	});
});

describe('an oversized body', () => {
	it('is refused with 413 on the declared length, unread', async () => {
		const { ctx } = fakeContext();
		const response = await handler(
			ctx,
			webhookRequest({ headers: { 'content-length': String(2 * 1_048_576) } })
		);
		expect(response.status).toBe(413);
	});

	it('is refused with 413 on the actual length when the header lies', async () => {
		const body = 'x'.repeat(1_048_577);
		const timestamp = Math.floor(Date.now() / 1000);
		const response = await handler(
			fakeContext().ctx,
			webhookRequest({ body, timestamp: String(timestamp), signature: sign(body, timestamp) })
		);
		expect(response.status).toBe(413);
	});

	it('measures BYTES, not UTF-16 units', async () => {
		// A body of three-byte characters is a third of the cap by `String.length`
		// and three times it on the wire. Measured wrong, the documented 1 MiB
		// ceiling would be a 3 MiB one for any non-Latin payload.
		const body = '漢'.repeat(400_000);
		expect(body.length).toBeLessThan(1_048_576);
		const timestamp = Math.floor(Date.now() / 1000);
		const response = await handler(
			fakeContext().ctx,
			webhookRequest({ body, timestamp: String(timestamp), signature: sign(body, timestamp) })
		);
		expect(response.status).toBe(413);
	});

	it('still accepts a multi-byte body that fits', async () => {
		const body = '漢'.repeat(1_000);
		const timestamp = Math.floor(Date.now() / 1000);
		const response = await handler(
			fakeContext().ctx,
			webhookRequest({ body, timestamp: String(timestamp), signature: sign(body, timestamp) })
		);
		expect(response.status).toBe(200);
	});
});

describe('an authentic, authorized delivery', () => {
	it('dispatches the parsed events with the host’s own attribution', async () => {
		const { ctx, scheduled } = fakeContext();
		const response = await handler(ctx, webhookRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, processed: 1 });
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		expect(mocks.dispatch.mock.calls[0]![1]).toEqual({
			kind: 'email.bounced',
			providerMessageId: BOUNCE.providerMessageId,
			at: expect.any(Number),
			bounceType: 'hard',
			providerType: KIND,
		});
		// Audited under the plugin's own attribution, on the operation literal that
		// means an inbound delivery — never `transport.send`.
		expect(scheduled).toEqual([
			{
				name: expect.stringContaining('sendTransportWebhookAuthorization:recordOutcome'),
				args: { pluginId: PLUGIN_ID, transportKind: KIND, outcome: 'completed' },
			},
		]);
	});

	it('dispatches a batch in order', async () => {
		mocks.parseEvents.mockImplementationOnce(() => [
			{ kind: 'deferred', providerMessageId: 'm1', at: Date.now() },
			{ kind: 'delivered', providerMessageId: 'm1', at: Date.now() },
		]);
		await handler(fakeContext().ctx, webhookRequest());

		expect(mocks.dispatch.mock.calls.map((call) => (call[1] as { kind: string }).kind)).toEqual([
			'email.deferred',
			'email.delivered',
		]);
	});

	it('accepts a complaint that carries only a recipient', async () => {
		mocks.parseEvents.mockImplementationOnce(() => [
			{ kind: 'complained', at: Date.now(), recipient: 'someone@example.com' },
		]);
		const response = await handler(fakeContext().ctx, webhookRequest());

		expect(response.status).toBe(200);
		expect(mocks.dispatch.mock.calls[0]![1]).toMatchObject({
			kind: 'email.complained',
			recipient: 'someone@example.com',
		});
	});

	it('records a failed outcome when dispatch throws', async () => {
		mocks.dispatch.mockRejectedValueOnce(new Error('boom'));
		const { ctx, scheduled } = fakeContext();
		await handler(ctx, webhookRequest());

		expect(scheduled[0]?.args).toMatchObject({ outcome: 'failed' });
	});

	it('does NOT retain the raw payload unless the adapter opted in', async () => {
		// Retention is opt-in per adapter: a third party's payload can carry
		// recipient content this deployment never asked to keep.
		const { ctx, stored } = fakeContext();
		await handler(ctx, webhookRequest());
		expect(stored).toEqual([]);
	});

	it('DOES retain it for the adapter that asked, under its own source', async () => {
		// The other branch of the same opt-in, and the only write on this route that
		// persists third-party payload content. Its failure is silent by design (an
		// audit write never fails a webhook), so nothing but a positive case pins
		// the mutation reference or its argument shape — and a deployment that
		// opted in and is keeping nothing finds out during a dispute.
		const { ctx, stored } = fakeContext();
		const response = await handler(
			ctx,
			webhookRequest({
				pluginId: mocks.retention.pluginId,
				secret: mocks.retention.secret,
			})
		);

		expect(response.status).toBe(200);
		expect(stored).toEqual([{ source: mocks.retention.kind, rawPayload: BODY }]);
	});

	it('answers 200 even when retention fails', async () => {
		const { ctx } = fakeContext({ isStorable: false });
		const response = await handler(
			ctx,
			webhookRequest({ pluginId: mocks.retention.pluginId, secret: mocks.retention.secret })
		);

		expect(response.status).toBe(200);
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
	});
});
