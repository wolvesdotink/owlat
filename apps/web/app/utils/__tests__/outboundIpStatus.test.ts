import { describe, expect, it } from 'vitest';
import { outboundIpPresentation, type OutboundIpIdentityInput } from '../outboundIpStatus';
import { createTestI18n } from '~/__tests__/i18n';

// The presentation is a pure derivation, so the chip label, the detail line and
// the remediation arrive as message keys; the copy an operator reads is resolved
// through the real catalog.
const { t } = createTestI18n().global;
const worded = (ip: OutboundIpIdentityInput) => {
	const status = outboundIpPresentation(ip);
	return {
		tone: status.tone,
		label: t(status.label),
		detail: t(status.detail),
		remediation: status.remediation === null ? null : t(status.remediation),
		consequence: status.consequence === null ? null : t(status.consequence),
		linksBlocklistLookups: status.linksBlocklistLookups,
	};
};

describe('outboundIpPresentation', () => {
	it.each([
		[
			{
				active: true,
				fcrdns: { verdict: 'pass', isGenericPtr: false, isOverridden: false, ptrNames: [] },
			},
			'success',
			'Ready',
		],
		[
			{
				active: true,
				fcrdns: { verdict: 'warn', isGenericPtr: true, isOverridden: false, ptrNames: [] },
			},
			'warning',
			'Needs attention',
		],
		[
			{
				active: false,
				blockReasons: ['fcrdns'],
				fcrdns: {
					verdict: 'fail',
					isGenericPtr: false,
					isOverridden: false,
					ptrNames: [],
					reason: 'no-ptr',
				},
			},
			'error',
			'Identity quarantined',
		],
		[
			{
				active: true,
				fcrdns: {
					verdict: 'fail',
					isGenericPtr: false,
					isOverridden: true,
					ptrNames: [],
					reason: 'no-ptr',
				},
			},
			'warning',
			'Lab override',
		],
	] as const)('maps runtime state to semantic UI state', (input, tone, label) => {
		expect(worded(input)).toMatchObject({ tone, label });
	});

	it('distinguishes DNSBL-only and combined quarantine causes', () => {
		expect(worded({ active: false, blockReasons: ['dnsbl'], dnsbl: 'critical' })).toMatchObject({
			label: 'Blocklisted',
			tone: 'error',
		});
		expect(
			worded({
				active: false,
				blockReasons: ['fcrdns', 'dnsbl'],
				dnsbl: 'critical',
				fcrdns: {
					verdict: 'fail',
					isGenericPtr: false,
					isOverridden: false,
					ptrNames: [],
					reason: 'no-ptr',
				},
			})
		).toMatchObject({ label: 'Identity + blocklist', tone: 'error' });
	});

	it('fails closed for an unknown readiness verdict', () => {
		expect(
			worded({
				active: true,
				fcrdns: {
					verdict: 'mysteriously-green',
					isGenericPtr: false,
					isOverridden: false,
					ptrNames: [],
				},
			})
		).toMatchObject({ label: 'Not verified', tone: 'error' });
	});

	it('does not render a recognized failed identity as ready when rolling payloads omit block reasons', () => {
		expect(
			worded({
				active: true,
				fcrdns: {
					verdict: 'fail',
					isGenericPtr: false,
					isOverridden: false,
					ptrNames: [],
					reason: 'no-ptr',
				},
			})
		).toMatchObject({ label: 'Identity quarantined', tone: 'error' });
	});

	it('treats a transient identity lookup error as unavailable, not as a confirmed quarantine', () => {
		expect(
			worded({
				active: true,
				fcrdns: {
					verdict: 'error',
					isGenericPtr: false,
					isOverridden: false,
					ptrNames: [],
					reason: 'lookup-error',
				},
			})
		).toMatchObject({ label: 'Not verified', tone: 'error', remediation: null });
	});

	it.each([
		['degraded', 'warning', 'Blocklist warning'],
		['unknown', 'error', 'Blocklist check unavailable'],
	] as const)('renders DNSBL %s as non-green without block reasons', (dnsbl, tone, label) => {
		expect(
			worded({
				active: true,
				dnsbl,
				fcrdns: { verdict: 'pass', isGenericPtr: false, isOverridden: false, ptrNames: [] },
			})
		).toMatchObject({ tone, label });
	});

	describe('an unmeasured blocklist check', () => {
		const verified = {
			verdict: 'pass',
			isGenericPtr: false,
			isOverridden: false,
			ptrNames: ['mail.example.com'],
		} as const;
		const unmeasured = (input: Partial<OutboundIpIdentityInput>) =>
			worded({
				active: false,
				blockReasons: ['dnsbl'],
				dnsbl: 'unknown',
				fcrdns: verified,
				...input,
			});

		it('names why the check failed and never sends the operator to request delisting', () => {
			const status = unmeasured({ dnsblUnknownReason: 'resolver_refused' });
			expect(status).toMatchObject({ tone: 'error', label: 'Blocklist check unavailable' });
			expect(status.detail).toContain('Spamhaus refused the blocklist check');
			expect(status.remediation).toContain('Data Query Service key');
			expect(status.remediation).not.toContain('delisting');
			expect(status.linksBlocklistLookups).toBe(true);
		});

		it.each([
			['rate_limited', 'too many queries', 'own query allowance'],
			['resolver_unreachable', 'got no answer', 'port 53'],
			['unusable_answer', "isn't a blocklist result", "doesn't rewrite answers"],
			['key_rejected', "didn't accept the Data Query Service key", 'replace the key'],
		] as const)('words %s with its own fix', (reason, detail, remediation) => {
			const status = unmeasured({ dnsblUnknownReason: reason });
			expect(status.detail).toContain(detail);
			expect(status.remediation).toContain(remediation);
		});

		it('says whether sending is held or carries on from the last good check', () => {
			expect(unmeasured({}).consequence).toContain("won't send from this IP");
			expect(unmeasured({ active: true, blockReasons: [] }).consequence).toContain(
				'last successful check'
			);
		});

		it('still points at the lookup, not delisting, when an older MTA sends no reason', () => {
			const status = unmeasured({});
			expect(status.detail).toContain("it's unknown whether this IP is listed");
			expect(status.remediation).toBe('Check how Owlat reaches the blocklists.');
		});

		it('keeps the combined identity line when both halves fail', () => {
			const status = unmeasured({
				blockReasons: ['dnsbl', 'fcrdns'],
				dnsblUnknownReason: 'resolver_refused',
				fcrdns: { ...verified, verdict: 'fail', reason: 'no-ptr', ptrNames: [] },
			});
			expect(status.detail).toContain('No PTR record exists');
			expect(status.detail).toContain("it's unknown whether this IP is listed");
			expect(status.linksBlocklistLookups).toBe(true);
		});

		it('leaves a confirmed listing on the delisting runbook', () => {
			const status = worded({
				active: false,
				blockReasons: ['dnsbl'],
				dnsbl: 'critical',
				fcrdns: verified,
			});
			expect(status.remediation).toContain('request delisting');
			expect(status.consequence).toBeNull();
			expect(status.linksBlocklistLookups).toBe(false);
		});
	});

	it('renders actionable remediation for a failed provider PTR', () => {
		const status = worded({
			active: false,
			blockReasons: ['fcrdns'],
			fcrdns: {
				verdict: 'fail',
				isGenericPtr: false,
				isOverridden: false,
				ptrNames: ['static.clients.your-server.de'],
				reason: 'ehlo-mismatch',
			},
		});
		expect(status.detail).toContain('does not match the EHLO');
		expect(status.remediation).toContain('Hetzner Console');
	});
});
