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
				fcrdns: {
					verdict: 'fail',
					isGenericPtr: false,
					isOverridden: false,
					ptrNames: [],
					reason: 'no-ptr',
				},
			},
			'error',
			'Quarantined',
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

	it('renders actionable remediation for a failed provider PTR', () => {
		const status = outboundIpPresentation({
			active: false,
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
