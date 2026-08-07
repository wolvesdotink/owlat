import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	PluginInboundSignatureAlgorithm,
	PluginInboundSignatureContract,
	PluginInboundSignatureEncoding,
	PluginReplayBoundSignatureContract,
} from '@owlat/plugin-kit';
import {
	verifyPluginInboundSignature,
	verifyPluginReplayBoundSignature,
} from '../inboundSignature';

const SECRET_ENV = 'PLUGIN_INBOUND_SECRET';
const SECRET = 'super-secret-signing-key';
const BODY = '{"event":"deal.won","id":"42"}';

function contract(
	algorithm: PluginInboundSignatureAlgorithm,
	encoding: PluginInboundSignatureEncoding
): PluginInboundSignatureContract {
	return { header: 'x-signature', algorithm, encoding, secretEnvVar: SECRET_ENV };
}

function reference(
	algorithm: PluginInboundSignatureAlgorithm,
	encoding: PluginInboundSignatureEncoding
): string {
	const hash = algorithm === 'hmac-sha256' ? 'sha256' : 'sha1';
	return createHmac(hash, SECRET).update(BODY).digest(encoding);
}

describe('plugin inbound signature verification', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		['hmac-sha256', 'hex'],
		['hmac-sha256', 'base64'],
		['hmac-sha1', 'hex'],
		['hmac-sha1', 'base64'],
	] as const)('accepts a correct %s / %s signature', async (algorithm, encoding) => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginInboundSignature(
			contract(algorithm, encoding),
			BODY,
			reference(algorithm, encoding)
		);
		expect(result.ok).toBe(true);
	});

	it('fails closed with 503 when the signing secret is unset', async () => {
		const result = await verifyPluginInboundSignature(
			contract('hmac-sha256', 'hex'),
			BODY,
			reference('hmac-sha256', 'hex')
		);
		expect(result).toMatchObject({ ok: false, status: 503 });
	});

	it.each([null, undefined, ''] as const)(
		'rejects a missing signature (%p) with 401',
		async (sig) => {
			vi.stubEnv(SECRET_ENV, SECRET);
			const result = await verifyPluginInboundSignature(contract('hmac-sha256', 'hex'), BODY, sig);
			expect(result).toMatchObject({ ok: false, status: 401 });
		}
	);

	it('rejects a tampered body / mismatched signature with 401', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginInboundSignature(
			contract('hmac-sha256', 'hex'),
			`${BODY} tampered`,
			reference('hmac-sha256', 'hex')
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a signature computed with the wrong secret', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const wrong = createHmac('sha256', 'attacker-key').update(BODY).digest('hex');
		const result = await verifyPluginInboundSignature(contract('hmac-sha256', 'hex'), BODY, wrong);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});
});

/**
 * The replay-bound form — the one that gates a live endpoint (D6/P2.2).
 *
 * Everything above proves ORIGIN. None of it proves FRESHNESS, and on an
 * unauthenticated internet-facing route those are different questions: a
 * captured request that verifies forever is a permanent licence to re-apply
 * whatever it carried. These cases pin the two things that close that — the
 * timestamp inside the signed string, and a digest the caller cannot forge for a
 * body they did not sign.
 */
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

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('accepts a fresh, correctly signed request and names the delivery', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginReplayBoundSignature(
			replayContract,
			BODY,
			signed(nowSeconds),
			String(nowSeconds),
			now
		);

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
		const verify = (body: string, timestampSeconds: number) =>
			verifyPluginReplayBoundSignature(
				replayContract,
				body,
				signed(timestampSeconds, body),
				String(timestampSeconds),
				timestampSeconds * 1000
			);
		const digest = async (body: string, timestampSeconds: number) => {
			const result = await verify(body, timestampSeconds);
			if (!result.ok) throw new Error('expected a verified result');
			return result.deliveryDigest;
		};

		expect(await digest(BODY, nowSeconds)).toBe(await digest(BODY, nowSeconds));
		// A different body or a different second is a different delivery — otherwise
		// one claim would swallow a legitimate later event.
		expect(await digest(BODY, nowSeconds)).not.toBe(await digest(`${BODY} `, nowSeconds));
		expect(await digest(BODY, nowSeconds)).not.toBe(await digest(BODY, nowSeconds + 1));
	});

	it.each([
		['a stale timestamp', -301],
		['a far-future timestamp', 301],
	] as const)('rejects %s with 401 even when the signature is valid', async (_label, offset) => {
		vi.stubEnv(SECRET_ENV, SECRET);
		const timestamp = nowSeconds + offset;
		const result = await verifyPluginReplayBoundSignature(
			replayContract,
			BODY,
			signed(timestamp),
			String(timestamp),
			now
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('accepts the edges of the declared tolerance', async () => {
		vi.stubEnv(SECRET_ENV, SECRET);
		for (const offset of [-300, 300]) {
			const timestamp = nowSeconds + offset;
			const result = await verifyPluginReplayBoundSignature(
				replayContract,
				BODY,
				signed(timestamp),
				String(timestamp),
				now
			);
			expect(result.ok, `offset ${offset}`).toBe(true);
		}
	});

	it.each([null, undefined, '', 'yesterday', '-5', '1.5', '9'.repeat(16)] as const)(
		'rejects a malformed timestamp (%p) with 401',
		async (timestamp) => {
			vi.stubEnv(SECRET_ENV, SECRET);
			const result = await verifyPluginReplayBoundSignature(
				replayContract,
				BODY,
				signed(nowSeconds),
				timestamp,
				now
			);
			expect(result).toMatchObject({ ok: false, status: 401 });
		}
	);

	it('rejects a signature over the body alone — the pre-replay scheme', async () => {
		// The whole point of binding the timestamp: a signature that would have
		// passed the origin-only verifier must not pass this one.
		vi.stubEnv(SECRET_ENV, SECRET);
		const result = await verifyPluginReplayBoundSignature(
			replayContract,
			BODY,
			createHmac('sha256', SECRET).update(BODY).digest('hex'),
			String(nowSeconds),
			now
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a timestamp rewritten to look fresh', async () => {
		// The attacker's obvious move against a freshness check that is not signed.
		vi.stubEnv(SECRET_ENV, SECRET);
		const captured = signed(nowSeconds - 10_000);
		const result = await verifyPluginReplayBoundSignature(
			replayContract,
			BODY,
			captured,
			String(nowSeconds),
			now
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('clamps a tolerance beyond the contract ceiling', async () => {
		// A generated artifact is not proof that the kit that validated it is the
		// kit running now, so the bound is applied again here.
		vi.stubEnv(SECRET_ENV, SECRET);
		const timestamp = nowSeconds - 1_000;
		const result = await verifyPluginReplayBoundSignature(
			{ ...replayContract, replay: { timestampHeader: 'x-timestamp', toleranceSeconds: 86_400 } },
			BODY,
			signed(timestamp),
			String(timestamp),
			now
		);
		expect(result).toMatchObject({ ok: false, status: 401 });
	});

	it('still fails closed with 503 when the secret is unset', async () => {
		const result = await verifyPluginReplayBoundSignature(
			replayContract,
			BODY,
			signed(nowSeconds),
			String(nowSeconds),
			now
		);
		expect(result).toMatchObject({ ok: false, status: 503 });
	});
});
