import { describe, expect, it } from 'vitest';
import {
	dnsBundleStatus,
	dnsRecordObservation,
	dnsResultStatus,
	mtaStsObservation,
} from '../checklistDnsObservations';
import { boundedObservedValues } from '../checklistEvidence';

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

		const parsed = JSON.parse(observation) as Record<string, unknown>;
		expect(observation.length).toBeLessThanOrEqual(512);
		expect(parsed).toMatchObject({
			kind: 'dns_record',
			label: 'dkim[0]',
			isVerified: false,
			checkedAt: 1_722_000_000_000,
		});
		expect(parsed).toHaveProperty('expected');
		expect(parsed).toHaveProperty('observed');
		expect(parsed).toHaveProperty('reason');
		expect(observation).toContain('…[length=');
	});

	it('serializes delimiter-like DNS text without allowing field spoofing', () => {
		const observation = dnsRecordObservation(
			'spf',
			'example.test',
			{ type: 'TXT', host: '@', value: 'v=spf1 -all; reason=fake' },
			{
				verified: false,
				foundValue: 'old; isVerified=true',
				error: 'mismatch; checkedAt=0',
				lastChecked: 42,
			}
		);
		const parsed = JSON.parse(observation) as Record<string, unknown>;

		expect(parsed).toMatchObject({
			expected: 'v=spf1 -all; reason=fake',
			observed: 'old; isVerified=true',
			isVerified: false,
			reason: 'mismatch; checkedAt=0',
			checkedAt: 42,
		});
	});

	it('keeps escape-heavy structured observations valid through persistence bounds', () => {
		const escapeHeavy = '\\"'.repeat(200);
		const observations = [
			dnsRecordObservation(
				escapeHeavy,
				`${escapeHeavy}.example.test`,
				{ type: 'TXT', host: escapeHeavy, value: escapeHeavy },
				{
					verified: false,
					foundValue: escapeHeavy,
					error: escapeHeavy,
					lastChecked: 1_722_000_000_000,
				}
			),
			mtaStsObservation({
				expectedId: escapeHeavy,
				observedId: escapeHeavy,
				isTxtRecordValid: false,
				isPolicyServedValid: false,
			}),
		];

		for (const serialized of boundedObservedValues(observations)) {
			expect(serialized.length).toBeLessThanOrEqual(512);
			expect(() => JSON.parse(serialized)).not.toThrow();
		}
	});
});
