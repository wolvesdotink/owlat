import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyProviderFeedbackRequest } from '../providerVerifierRegistry';

const originalSecret = process.env['MTA_WEBHOOK_SECRET'];

afterEach(() => {
	if (originalSecret === undefined) delete process.env['MTA_WEBHOOK_SECRET'];
	else process.env['MTA_WEBHOOK_SECRET'] = originalSecret;
});

describe('provider verifier registry', () => {
	it.each([
		['sha256', 'hex'],
		['sha256', 'base64'],
		['sha1', 'hex'],
		['sha1', 'base64'],
	] as const)('verifies timestamp-bound %s/%s HMAC', async (algorithm, encoding) => {
		process.env['MTA_WEBHOOK_SECRET'] = 'registry-secret';
		const timestamp = `${Math.floor(Date.now() / 1_000)}`;
		const body = '{"event":"test"}';
		const signature = createHmac(algorithm, 'registry-secret')
			.update(`${timestamp}.${body}`)
			.digest(encoding);
		const result = await verifyProviderFeedbackRequest(
			new Request('https://example.test/webhook', {
				headers: { 'x-signature': signature, 'x-timestamp': timestamp },
			}),
			body,
			{
				scheme: 'hmac-timestamp-body',
				algorithm,
				encoding,
				signatureHeader: 'x-signature',
				timestampHeader: 'x-timestamp',
				secretEnvVar: 'MTA_WEBHOOK_SECRET',
				toleranceSeconds: 300,
			}
		);
		expect(result).toEqual({ ok: true });
	});

	it('fails closed before comparison when the secret is absent', async () => {
		delete process.env['MTA_WEBHOOK_SECRET'];
		const result = await verifyProviderFeedbackRequest(
			new Request('https://example.test/webhook'),
			'{}',
			{
				scheme: 'hmac-timestamp-body',
				algorithm: 'sha256',
				encoding: 'hex',
				signatureHeader: 'x-signature',
				timestampHeader: 'x-timestamp',
				secretEnvVar: 'MTA_WEBHOOK_SECRET',
				toleranceSeconds: 300,
			}
		);
		expect(result).toMatchObject({ ok: false, status: 503 });
	});
});
