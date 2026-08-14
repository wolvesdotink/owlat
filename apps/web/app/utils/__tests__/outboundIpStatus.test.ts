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
