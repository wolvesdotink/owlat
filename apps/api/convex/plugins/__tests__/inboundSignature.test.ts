/**
 * The replay-bound form — the one that gates a live endpoint (D6/P2.2).
 *
 * `./importProviderSignature.test.ts` proves ORIGIN. None of that proves
 * FRESHNESS, and on an unauthenticated internet-facing route those are different
 * questions: a captured request that verifies forever is a permanent licence to
 * re-apply whatever it carried. These cases pin the three things that close it —
 * the timestamp inside the signed string, a digest the caller cannot forge for a
 * body they did not sign, and a digest that names ONE plugin's delivery.
 */

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginReplayBoundSignatureContract } from '@owlat/plugin-kit';
import { verifyPluginReplayBoundSignature, type ReplayBoundDelivery } from '../inboundSignature';

const SECRET_ENV = 'PLUGIN_INBOUND_SECRET';
const SECRET = 'super-secret-signing-key';
const BODY = '{"event":"deal.won","id":"42"}';

describe('replay-bound plugin inbound signature verification', () => {
	const replayContract: PluginReplayBoundSignatureContract = {
		header: 'x-signature',
		algorithm: 'hmac-sha256',
		encoding: 'hex',
		secretEnvVar: SECRET_ENV,
		replay: { timestampHeader: 'x-timestamp', toleranceSeconds: 300 },
	};

	function signed(timestampSeconds: number, body = BODY, secret = SECRET): string {
		return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
	}

	const now = 1_770_000_000_000;
	const nowSeconds = Math.floor(now / 1000);

	/** One delivery to `mail-pack`'s route, with whatever this case overrides. */
	function delivery(overrides: Partial<ReplayBoundDelivery> = {}): ReplayBoundDelivery {
		return {
			contract: replayContract,
			pluginId: 'mail-pack',
			transportKind: 'plugin.mail-pack.postmark',
			rawBody: BODY,
			signature: signed(nowSeconds),
			timestamp: String(nowSeconds),
			nowMs: now,
			...overrides,
		};
	}

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('accepts a fresh, correctly signed request and names the delivery', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginReplayBoundSignature(delivery());

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		expect(result.deliveryDigest).toMatch(/^[0-9a-f]{64}$/);
		// Never the signature itself: this value is stored, and the signature is a
		// live MAC under a shared secret.
		expect(result.deliveryDigest).not.toBe(signed(nowSeconds));
		// The claim outlives the window in which the same request still verifies.
		expect(result.expiresAtMs).toBeGreaterThan(now + 300_000);
	});

	it('gives identical bytes the same digest, and anything else a different one', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const digest = async (overrides: Partial<ReplayBoundDelivery>) => {
			const result = await verifyPluginReplayBoundSignature(delivery(overrides));
			if (!result.ok) throw new Error('expected a verified result');
			return result.deliveryDigest;
		};
		const same = { rawBody: BODY, signature: signed(nowSeconds) };

		expect(await digest(same)).toBe(await digest(same));
		// A different body or a different second is a different delivery — otherwise
		// one claim would swallow a legitimate later event.
		expect(await digest(same)).not.toBe(
			await digest({ rawBody: `${BODY} `, signature: signed(nowSeconds, `${BODY} `) })
		);
		expect(await digest(same)).not.toBe(
			await digest({ timestamp: String(nowSeconds + 1), signature: signed(nowSeconds + 1) })
		);
	});

	it('names ONE plugin: the same signed bytes at another route are another delivery', async () => {
		// Two bundled plugins may legitimately end up with the same secret value
		// (an operator can set two variables to one string). If the digest ignored
		// the owner, the first claim would 409 the second plugin's real bounce and
		// that feedback would be lost — a claim is only released on OUR failure.
		vi.stubEnv(SECRET_ENV, SECRET);
		const digest = async (overrides: Partial<ReplayBoundDelivery>) => {
			const result = await verifyPluginReplayBoundSignature(delivery(overrides));
			if (!result.ok) throw new Error('expected a verified result');
			return result.deliveryDigest;
		};

		expect(await digest({})).not.toBe(await digest({ pluginId: 'other-pack' }));
		expect(await digest({})).not.toBe(await digest({ transportKind: 'plugin.mail-pack.other' }));
	});

	it.each([
		['a stale timestamp', -301],
		['a far-future timestamp', 301],
	] as const)('rejects %s with 401 even when the signature is valid', async (_label, offset) => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const timestamp = nowSeconds + offset;
		const result = await verifyPluginReplayBoundSignature(
			delivery({ signature: signed(timestamp), timestamp: String(timestamp) })
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('accepts the edges of the declared tolerance', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		for (const offset of [-300, 300]) {
			const timestamp = nowSeconds + offset;
			const result = await verifyPluginReplayBoundSignature(
				delivery({ signature: signed(timestamp), timestamp: String(timestamp) })
			);
			expect(result.ok, `offset ${offset}`).toBe(true);
		}
	});

	it.each([null, undefined, '', 'yesterday', '-5', '1.5', '9'.repeat(16)] as const)(
		'rejects a malformed timestamp (%p) with 401',
		async (timestamp) => {
			vi.stubEnv(SECRET_ENV, SECRET);
			const result = await verifyPluginReplayBoundSignature(delivery({ timestamp }));
			expect(result).toMatchObject({ ok: false, status: 401 });
		}
	);

	it('rejects a signature over the body alone — the pre-replay scheme', async () => {
		// The whole point of binding the timestamp: a signature that would have
		// passed the origin-only verifier must not pass this one.
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginReplayBoundSignature(
			delivery({ signature: createHmac('sha256', SECRET).update(BODY).digest('hex') })
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a timestamp rewritten to look fresh', async () => {
		// The attacker's obvious move against a freshness check that is not signed.
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginReplayBoundSignature(
			delivery({ signature: signed(nowSeconds - 10_000) })
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('clamps a tolerance beyond the contract ceiling', async () => {
		// A generated artifact is not proof that the kit that validated it is the
		// kit running now, so the bound is applied again here.
		vi.stubEnv(SECRET_ENV, SECRET);
		const timestamp = nowSeconds - 1_000;
		const result = await verifyPluginReplayBoundSignature(
			delivery({
				contract: {
					...replayContract,
					replay: { timestampHeader: 'x-timestamp', toleranceSeconds: 86_400 },
				},
				signature: signed(timestamp),
				timestamp: String(timestamp),
			})
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('still fails closed with 503 when the secret is unset', async () => {
		const result = await verifyPluginReplayBoundSignature(delivery());
		expect(result).toMatchObject({ ok: false, status: 503 });
	});

	it.each([
		['a stale timestamp', String(nowSeconds - 10_000)],
		['a malformed timestamp', 'yesterday'],
		['no timestamp at all', null],
	] as const)(
		'answers 503 rather than 401 for %s while the secret is unset',
		async (_label, timestamp) => {
			// The documented order is the real one: an operator wiring the endpoint up
			// sees "this deployment is misconfigured", not a caller-shaped 401 that
			// sends them looking at the provider's clock.
			const result = await verifyPluginReplayBoundSignature(delivery({ timestamp }));
			expect(result).toMatchObject({ ok: false, status: 503 });
		}
	);
});
