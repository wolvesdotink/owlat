import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	PluginInboundSignatureAlgorithm,
	PluginInboundSignatureContract,
	PluginInboundSignatureEncoding,
} from '@owlat/plugin-kit';
import { verifyPluginInboundSignature } from '../inboundSignature';

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
