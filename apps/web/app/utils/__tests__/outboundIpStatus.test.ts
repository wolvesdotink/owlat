import { describe, expect, it } from 'vitest';
import { outboundIpPresentation } from '../outboundIpStatus';

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
		expect(outboundIpPresentation(input)).toMatchObject({ tone, label });
	});

	it('distinguishes DNSBL-only and combined quarantine causes', () => {
		expect(
			outboundIpPresentation({ active: false, blockReasons: ['dnsbl'], dnsbl: 'critical' })
		).toMatchObject({ label: 'Blocklisted', tone: 'error' });
		expect(
			outboundIpPresentation({
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
			outboundIpPresentation({
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
			outboundIpPresentation({
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
			outboundIpPresentation({
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
			outboundIpPresentation({
				active: true,
				dnsbl,
				fcrdns: { verdict: 'pass', isGenericPtr: false, isOverridden: false, ptrNames: [] },
			})
		).toMatchObject({ tone, label });
	});

	it('renders actionable remediation for a failed provider PTR', () => {
		const status = outboundIpPresentation({
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
