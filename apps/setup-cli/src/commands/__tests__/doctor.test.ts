import { describe, it, expect } from 'vitest';
import {
	evaluateIpAuditReport,
	evaluateMtaHealth,
	evaluateMtaIdentityHealth,
	evaluateSendPath,
} from '../doctor';
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
		ips: [
			{
				ip: '192.0.2.10',
				fcrdns: { verdict: 'pass', ehlo: 'mail1.example.com', ptrNames: ['mail1.example.com'] },
			},
			{
				ip: '192.0.2.11',
				fcrdns: { verdict: 'pass', ehlo: 'mail2.example.com', ptrNames: ['mail2.example.com'] },
			},
		],
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
		expect(findings).toHaveLength(8);
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

	it('adds one short provider note when TCP/25 is blocked, and none when it is open', () => {
		const blocked = {
			...healthy,
			status: 'degraded',
			smtpOutbound: {
				status: 'degraded',
				ips: [
					{ ip: '192.0.2.10', status: 'ok' },
					{ ip: '192.0.2.11', status: 'failed', reason: 'timeout' },
				],
			},
		};
		const withHint = evaluateMtaHealth(blocked, { MTA_VPS_PROVIDER: 'digitalocean' });
		const failed = withHint.filter((finding) => !finding.ok);
		expect(failed[0]?.message).toContain('DigitalOcean blocks SMTP ports');

		const generic = evaluateMtaHealth(blocked, {});
		expect(generic.filter((finding) => !finding.ok)[0]?.message).toMatch(/block/i);

		expect(
			evaluateMtaHealth(healthy, { MTA_VPS_PROVIDER: 'digitalocean' }).every(
				(finding) => !finding.message.includes('DigitalOcean')
			)
		).toBe(true);
	});

	it('prints the provider note once however many addresses are blocked', () => {
		const findings = evaluateMtaHealth(
			{
				...healthy,
				status: 'degraded',
				smtpOutbound: {
					status: 'degraded',
					ips: [
						{ ip: '192.0.2.11', status: 'failed', reason: 'timeout' },
						{ ip: '192.0.2.12', status: 'failed', reason: 'timeout' },
						{ ip: '192.0.2.13', status: 'failed', reason: 'timeout' },
					],
				},
			},
			{ MTA_VPS_PROVIDER: 'digitalocean' }
		);
		const nudged = findings.filter((finding) => finding.message.includes('DigitalOcean'));
		expect(nudged).toHaveLength(1);
		expect(nudged[0]?.message).toContain('192.0.2.11');
		expect(findings.filter((finding) => finding.message.includes('TCP/25'))).toHaveLength(3);
	});

	it('fails closed on an incomplete response', () => {
		expect(evaluateMtaHealth({ status: 'ok' })).toEqual([
			{ ok: false, message: 'MTA returned an incomplete health response' },
		]);
	});
});

/**
 * The installer surface of the pre-flight IP audit: the operator must see the
 * verdict and the delisting path before investing hours in DNS, and an install
 * with no audit at all must stay completely silent (additive-only).
 */
describe('doctor — pre-flight IP audit verdict', () => {
	it('passes and states the verdict for a clean address', () => {
		const findings = evaluateIpAuditReport({
			audits: [
				{
					ip: '203.0.113.10',
					verdict: 'clean',
					confidence: 'high',
					headline: 'This address looks clean and ready to set up.',
					nextAction: 'Continue with DNS setup: publish SPF, DKIM, and DMARC.',
					delisting: [],
				},
			],
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(true);
		expect(findings[0]?.message).toContain('203.0.113.10');
		expect(findings[0]?.message).toContain('looks clean');
		expect(findings[0]?.message).not.toContain('confidence');
	});

	it('shows the zone-specific removal URL and next action for a PBL listing', () => {
		const findings = evaluateIpAuditReport({
			audits: [
				{
					ip: '203.0.113.11',
					verdict: 'action_required',
					confidence: 'high',
					headline: 'This address can work once you fix one thing.',
					nextAction: 'Request a PBL exclusion for this address, or ask your provider to do it.',
					delisting: [
						{
							key: 'spamhaus:pbl',
							label: 'Spamhaus PBL',
							removalUrl: 'https://www.spamhaus.org/pbl/removal/',
						},
					],
				},
			],
		});
		expect(findings).toHaveLength(1);
		// Fixable, so it does not fail the install — but it is never silent.
		expect(findings[0]?.ok).toBe(true);
		expect(findings[0]?.message).toContain('PBL exclusion');
		expect(findings[0]?.message).toContain('https://www.spamhaus.org/pbl/removal/');
	});

	it('FAILS doctor on an unusable address so the installer cannot proceed silently', () => {
		const findings = evaluateIpAuditReport({
			audits: [
				{
					ip: '203.0.113.12',
					verdict: 'unusable',
					confidence: 'high',
					headline: 'This address will not work for sending mail.',
					nextAction: 'Ask your provider for an address outside this range.',
					delisting: [
						{
							key: 'spamhaus:drop',
							label: 'Spamhaus DROP',
							removalUrl: 'https://www.spamhaus.org/drop/',
						},
					],
				},
			],
		});
		expect(findings[0]?.ok).toBe(false);
		expect(findings[0]?.message).toContain('will not work');
		expect(findings[0]?.message).toContain('https://www.spamhaus.org/drop/');
	});

	it('names low measurement confidence rather than hiding it', () => {
		const findings = evaluateIpAuditReport({
			audits: [
				{
					ip: '203.0.113.13',
					verdict: 'clean',
					confidence: 'low',
					headline: 'This address looks clean and ready to set up.',
					nextAction: 'Re-run the audit later.',
				},
			],
		});
		expect(findings[0]?.ok).toBe(true);
		expect(findings[0]?.message).toContain('measurement confidence: low');
	});

	it('prints nothing when no audit exists, the payload is unreadable, or a row is malformed', () => {
		expect(evaluateIpAuditReport({ audits: [] })).toEqual([]);
		expect(evaluateIpAuditReport({})).toEqual([]);
		expect(evaluateIpAuditReport(null)).toEqual([]);
		expect(evaluateIpAuditReport('not json at all')).toEqual([]);
		expect(evaluateIpAuditReport({ audits: [{ ip: 203 }, { verdict: 'unusable' }] })).toEqual([]);
		// A verdict we do not recognise is ignored rather than reported as broken.
		expect(evaluateIpAuditReport({ audits: [{ ip: '203.0.113.14', verdict: 'weird' }] })).toEqual(
			[]
		);
	});

	it('reports every configured address', () => {
		const findings = evaluateIpAuditReport({
			audits: [
				{ ip: '203.0.113.10', verdict: 'clean', headline: 'ok', confidence: 'high' },
				{ ip: '203.0.113.11', verdict: 'unusable', headline: 'no', confidence: 'high' },
			],
		});
		expect(findings.map((finding) => finding.ok)).toEqual([true, false]);
	});
});

describe('doctor — FCrDNS setup guidance', () => {
	it('fails with the exact desired PTR and provider-specific click path', () => {
		const findings = evaluateMtaIdentityHealth({
			ips: [
				{
					ip: '192.0.2.10',
					fcrdns: {
						verdict: 'fail',
						reason: 'ehlo-mismatch',
						ehlo: 'mail.example.com',
						ptrNames: ['static.clients.your-server.de'],
					},
				},
			],
		});
		expect(findings[0]?.ok).toBe(false);
		expect(findings[0]?.message).toContain('Set its PTR exactly to mail.example.com');
		expect(findings[0]?.message).toContain('Hetzner Console');
	});
});
