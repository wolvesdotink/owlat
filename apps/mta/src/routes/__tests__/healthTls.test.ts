import { describe, expect, it } from 'vitest';
import {
	classifySmtpTlsCertificate,
	dkimSigningReadiness,
	inspectSmtpTlsCertificate,
} from '../health.js';

describe('SMTP TLS certificate readiness', () => {
	const now = Date.UTC(2026, 6, 26);

	it('warns when a confirmed certificate expires within fourteen days', () => {
		expect(
			classifySmtpTlsCertificate(
				{
					hostname: 'mail.example.test',
					isHostnameMatched: true,
					validFrom: now - 1_000,
					validTo: now + 13 * 24 * 60 * 60 * 1_000,
				},
				now
			)
		).toMatchObject({ status: 'warn', reason: 'expires-within-14-days' });
	});

	it('fails missing and malformed configured certificates honestly', () => {
		expect(inspectSmtpTlsCertificate(undefined, 'mail.example.test', now)).toMatchObject({
			status: 'fail',
			reason: 'certificate-not-configured',
		});
		expect(inspectSmtpTlsCertificate('not a certificate', 'mail.example.test', now)).toMatchObject({
			status: 'fail',
			reason: 'certificate-invalid',
		});
	});

	it('reports a watched certificate that has not been published yet as pending', () => {
		expect(inspectSmtpTlsCertificate(undefined, 'mail.example.test', now, true)).toMatchObject({
			status: 'fail',
			reason: 'certificate-pending',
		});
	});
});

describe('DKIM signing readiness', () => {
	it('is ok with no held domain', () => {
		expect(dkimSigningReadiness([])).toEqual({ status: 'ok', held: [] });
	});

	it('names each held domain and its cause', () => {
		const held = [{ domain: 'brand.example', cause: 'no_key' as const, since: 1 }];
		expect(dkimSigningReadiness(held)).toEqual({ status: 'held', held });
	});
});
