import { describe, it, expect } from 'vitest';
import { evaluateMtaHealth, evaluateSendPath } from '../doctor';
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
		const findings = evaluateSendPath(sending, {
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_x',
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(true);
	});
});

describe('doctor — evaluateMtaHealth', () => {
	const healthy = {
		status: 'ok',
		redis: 'connected',
		worker: { alive: true },
		dns: 'ok',
		emergency: { allIpsBlocked: false },
		smtpOutbound: {
			status: 'ok',
			ips: [
				{ ip: '192.0.2.10', status: 'ok' },
				{ ip: '192.0.2.11', status: 'ok' },
			],
		},
	};

	it('passes each infrastructure and per-IP SMTP check when healthy', () => {
		const findings = evaluateMtaHealth(healthy);
		expect(findings).toHaveLength(6);
		expect(findings.every((finding) => finding.ok)).toBe(true);
	});

	it('fails the exact source IP whose TCP/25 connection is blocked', () => {
		const findings = evaluateMtaHealth({
			...healthy,
			status: 'degraded',
			smtpOutbound: {
				status: 'degraded',
				ips: [
					{ ip: '192.0.2.10', status: 'ok' },
					{ ip: '192.0.2.11', status: 'failed', reason: 'network_unreachable' },
				],
			},
		});
		const failed = findings.filter((finding) => !finding.ok);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.message).toContain('192.0.2.11');
		expect(failed[0]?.message).toContain('network unreachable');
	});

	it('fails closed on an incomplete response', () => {
		expect(evaluateMtaHealth({ status: 'ok' })).toEqual([
			{ ok: false, message: 'MTA returned an incomplete health response' },
		]);
	});
});
