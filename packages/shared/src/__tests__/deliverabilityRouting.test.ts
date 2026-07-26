import { describe, expect, it } from 'vitest';
import {
	ADVISORY_DELIVERABILITY_SIGNAL_SOURCES,
	DELIVERABILITY_SIGNAL_SOURCES,
	destinationProviderForDomain,
	hasCriticalBlocklistSignal,
	isActionableDeliverabilitySignalSource,
	isAdvisoryDeliverabilitySignalSource,
	isDeliverabilitySignalSource,
	normalizeDeliverabilityRoutingSnapshot,
	type DeliverabilitySignal,
	type DeliverabilitySignalSource,
} from '../deliverabilityRouting';

function blocklistSignal(overrides: Partial<DeliverabilitySignal> = {}): DeliverabilitySignal {
	return {
		provider: 'all',
		source: 'dnsbl_listed',
		severity: 'critical',
		observedAt: 100,
		...overrides,
	};
}

describe('deliverability routing DTO', () => {
	it('accepts a bounded fixed-taxonomy snapshot', () => {
		expect(
			normalizeDeliverabilityRoutingSnapshot(
				{
					generatedAt: 100,
					signals: [
						{
							provider: 'gmail',
							source: 'persistent_defers',
							severity: 'warning',
							observedAt: 90,
						},
					],
				},
				100
			)
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
		expect(normalizeDeliverabilityRoutingSnapshot(input, 1)).toBeNull();
	});

	it.each([
		{
			generatedAt: 100,
			signals: [],
			extra: true,
		},
		{
			generatedAt: 100,
			signals: [
				{
					provider: 'gmail',
					source: 'breaker_open',
					severity: 'critical',
					observedAt: 100,
					rawError: 'unchecked',
				},
			],
		},
	])('rejects unknown DTO keys', (input) => {
		expect(normalizeDeliverabilityRoutingSnapshot(input, 100)).toBeNull();
	});

	it('rejects stale, future, and snapshot-inconsistent observation times', () => {
		const signal = {
			provider: 'gmail',
			source: 'breaker_open',
			severity: 'critical',
		};
		expect(
			normalizeDeliverabilityRoutingSnapshot(
				{ generatedAt: 1_000_000, signals: [{ ...signal, observedAt: 1_000_001 }] },
				1_000_000
			)
		).toBeNull();
		expect(
			normalizeDeliverabilityRoutingSnapshot(
				{ generatedAt: 1_000_000, signals: [{ ...signal, observedAt: 1 }] },
				1_000_000
			)
		).toBeNull();
		expect(
			normalizeDeliverabilityRoutingSnapshot({ generatedAt: 1_200_001, signals: [] }, 1_000_000)
		).toBeNull();
	});

	it('classifies only conservative consumer-provider domains', () => {
		expect(destinationProviderForDomain('GMAIL.COM.')).toBe('gmail');
		expect(destinationProviderForDomain('outlook.com')).toBe('microsoft');
		expect(destinationProviderForDomain('company-on-google.example')).toBe('other');
	});
});

describe('deliverability signal taxonomy', () => {
	it('accepts the DNSBL three-state sources and rejects anything outside the union', () => {
		expect(isDeliverabilitySignalSource('dnsbl_partial')).toBe(true);
		expect(isDeliverabilitySignalSource('dnsbl_unknown')).toBe(true);
		expect(isDeliverabilitySignalSource('dnsbl_listed')).toBe(true);
		expect(isDeliverabilitySignalSource('dnsbl_clean')).toBe(false);
		expect(isDeliverabilitySignalSource(undefined)).toBe(false);
		expect(isDeliverabilitySignalSource(42)).toBe(false);
	});

	it('splits the union exhaustively into advisory and actionable', () => {
		for (const source of DELIVERABILITY_SIGNAL_SOURCES) {
			expect(isAdvisoryDeliverabilitySignalSource(source)).toBe(
				!isActionableDeliverabilitySignalSource(source)
			);
		}
		expect(DELIVERABILITY_SIGNAL_SOURCES.filter(isAdvisoryDeliverabilitySignalSource)).toEqual([
			...ADVISORY_DELIVERABILITY_SIGNAL_SOURCES,
		]);
		// The shipped fallback + hysteresis sources stay actionable.
		const shipped: DeliverabilitySignalSource[] = [
			'ip_quarantined',
			'dnsbl_listed',
			'breaker_open',
			'persistent_defers',
		];
		for (const source of shipped) {
			expect(isActionableDeliverabilitySignalSource(source)).toBe(true);
		}
	});

	it('normalizes advisory sources rather than rejecting them', () => {
		const snapshot = normalizeDeliverabilityRoutingSnapshot(
			{
				generatedAt: 100,
				signals: [
					{ provider: 'all', source: 'dnsbl_partial', severity: 'critical', observedAt: 100 },
					{ provider: 'all', source: 'dnsbl_unknown', severity: 'warning', observedAt: 100 },
				],
			},
			100
		);
		expect(snapshot?.signals.map((entry) => entry.source)).toEqual([
			'dnsbl_partial',
			'dnsbl_unknown',
		]);
	});

	it('raises the critical blocklist hard stop for a wholly or partly ejected pool only', () => {
		expect(hasCriticalBlocklistSignal([blocklistSignal({ source: 'dnsbl_listed' })])).toBe(true);
		expect(hasCriticalBlocklistSignal([blocklistSignal({ source: 'dnsbl_partial' })])).toBe(true);
		// Unmeasurable is not evidence of harm any more than it is of health.
		expect(
			hasCriticalBlocklistSignal([blocklistSignal({ source: 'dnsbl_unknown', severity: 'warning' })])
		).toBe(false);
		expect(
			hasCriticalBlocklistSignal([blocklistSignal({ source: 'dnsbl_listed', severity: 'warning' })])
		).toBe(false);
		expect(hasCriticalBlocklistSignal([blocklistSignal({ source: 'ip_quarantined' })])).toBe(false);
		expect(hasCriticalBlocklistSignal([])).toBe(false);
	});
});
