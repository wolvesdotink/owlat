import { describe, expect, it } from 'vitest';
import {
	dnsBundleStatus,
	dnsRecordObservation,
	dnsResultStatus,
} from '../checklistDnsObservations';

describe('deliverability DNS observations', () => {
	it('keeps every mismatch pending until the final propagation attempt', () => {
		const mismatch = {
			verified: false,
			foundValue: 'old-value',
			error: 'Record found but value does not match',
		};
		expect(dnsResultStatus(mismatch, false)).toBe('pending-dns');
		expect(dnsResultStatus(mismatch, true)).toBe('fail');
		expect(dnsBundleStatus([mismatch], false, 1)).toBe('pending-dns');
		expect(dnsBundleStatus([mismatch], true, 1)).toBe('fail');
		expect(dnsBundleStatus([{ verified: true }], false, 2)).toBe('pending-dns');
		expect(dnsBundleStatus([{ verified: true }], true, 2)).toBe('fail');
	});

	it('bounds large DNS fields without dropping status, reason, or timestamp', () => {
		const observation = dnsRecordObservation(
			'dkim[0]',
			'example.test',
			{
				type: 'TXT',
				host: 'selector._domainkey',
				value: `v=DKIM1; p=${'a'.repeat(700)}`,
			},
			{
				verified: false,
				foundValue: `v=DKIM1; p=${'b'.repeat(700)}`,
				error: 'mismatch '.repeat(100),
				lastChecked: 1_722_000_000_000,
			}
		);

		expect(observation.length).toBeLessThanOrEqual(512);
		expect(observation).toContain('expected=');
		expect(observation).toContain('observed=');
		expect(observation).toContain('verified=false');
		expect(observation).toContain('reason=');
		expect(observation).toContain('checked-at=1722000000000');
		expect(observation).toContain('…[length=');
	});
});
