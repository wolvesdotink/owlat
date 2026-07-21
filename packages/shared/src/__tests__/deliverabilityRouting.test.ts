import { describe, expect, it } from 'vitest';
import {
	destinationProviderForDomain,
	normalizeDeliverabilityRoutingSnapshot,
} from '../deliverabilityRouting';

describe('deliverability routing DTO', () => {
	it('accepts a bounded fixed-taxonomy snapshot', () => {
		expect(
			normalizeDeliverabilityRoutingSnapshot({
				generatedAt: 100,
				signals: [
					{
						provider: 'gmail',
						source: 'persistent_defers',
						severity: 'warning',
						observedAt: 90,
					},
				],
			})
		).toEqual({
			generatedAt: 100,
			signals: [
				{
					provider: 'gmail',
					source: 'persistent_defers',
					severity: 'warning',
					observedAt: 90,
				},
			],
		});
	});

	it.each([
		{
			generatedAt: 1,
			signals: [{ provider: 'gmail', source: 'raw-error', severity: 'warning', observedAt: 1 }],
		},
		{
			generatedAt: 1,
			signals: [
				{ provider: 'unknown', source: 'breaker_open', severity: 'warning', observedAt: 1 },
			],
		},
		{
			generatedAt: 1,
			signals: [{ provider: 'gmail', source: 'breaker_open', severity: 'fatal', observedAt: 1 }],
		},
		{ generatedAt: Number.NaN, signals: [] },
	])('rejects malformed signal input', (input) => {
		expect(normalizeDeliverabilityRoutingSnapshot(input)).toBeNull();
	});

	it('classifies only conservative consumer-provider domains', () => {
		expect(destinationProviderForDomain('GMAIL.COM.')).toBe('gmail');
		expect(destinationProviderForDomain('outlook.com')).toBe('microsoft');
		expect(destinationProviderForDomain('company-on-google.example')).toBe('other');
	});
});
