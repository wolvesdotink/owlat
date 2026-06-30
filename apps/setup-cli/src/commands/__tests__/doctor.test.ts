import { describe, it, expect } from 'vitest';
import { evaluateSendPath } from '../doctor';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';

/**
 * `evaluateSendPath` is the pure decision that drives doctor's SEND-PATH check
 * (and thus its exit code). It is unit-tested directly because `runDoctor` reads
 * the filesystem and shells out via the Bun runtime, which is unavailable under
 * the vitest/node test environment.
 */
describe('doctor — evaluateSendPath', () => {
	const sending: FeatureFlagState = { campaigns: true };

	it('returns no findings when no sending feature is active (nothing to verify)', () => {
		const receivingOnly: FeatureFlagState = {
			campaigns: false,
			transactional: false,
			automations: false,
			inbox: true,
		};
		expect(evaluateSendPath(receivingOnly, { EMAIL_PROVIDER: 'mta' })).toEqual([]);
		// Even with a totally empty env — a receiving-only posture needs no provider.
		expect(evaluateSendPath(receivingOnly, {})).toEqual([]);
	});

	it('FAILS when provider=mta but MTA_API_URL is absent', () => {
		const findings = evaluateSendPath(sending, { EMAIL_PROVIDER: 'mta', MTA_API_KEY: 'k' });
		const urlFinding = findings.find((f) => f.message.includes('MTA_API_URL'));
		expect(urlFinding?.ok).toBe(false);
		// Doctor fails iff any finding is not ok.
		expect(findings.some((f) => !f.ok)).toBe(true);
	});

	it('PASSES when provider=mta and both MTA_API_URL and MTA_API_KEY are present', () => {
		const findings = evaluateSendPath(sending, {
			EMAIL_PROVIDER: 'mta',
			MTA_API_URL: 'http://mta:3100',
			MTA_API_KEY: 'mta_secret',
		});
		expect(findings).toHaveLength(2);
		expect(findings.every((f) => f.ok)).toBe(true);
	});

	it('FAILS when a sending feature is enabled but EMAIL_PROVIDER is unset', () => {
		const findings = evaluateSendPath(sending, {});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(false);
		expect(findings[0]?.message).toMatch(/EMAIL_PROVIDER is unset/);
	});

	it('FAILS when EMAIL_PROVIDER names an unknown provider (no implicit MTA default)', () => {
		const findings = evaluateSendPath(sending, { EMAIL_PROVIDER: 'sendgrid' });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(false);
		expect(findings[0]?.message).toContain('sendgrid');
	});

	it('FAILS when provider=ses is missing a required credential', () => {
		const findings = evaluateSendPath(sending, {
			EMAIL_PROVIDER: 'ses',
			AWS_SES_REGION: 'us-east-1',
			AWS_SES_ACCESS_KEY_ID: 'AKIA...',
			// AWS_SES_SECRET_ACCESS_KEY intentionally absent
		});
		expect(findings.some((f) => !f.ok)).toBe(true);
		const secret = findings.find((f) => f.message.includes('AWS_SES_SECRET_ACCESS_KEY'));
		expect(secret?.ok).toBe(false);
	});

	it('PASSES when provider=resend and RESEND_API_KEY is present', () => {
		const findings = evaluateSendPath(sending, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(true);
	});
});
