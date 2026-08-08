import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_SIGNAL_SOURCES,
	DELIVERABILITY_SNAPSHOT_MAX_AGE_MS,
	DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS,
	OUTCOME_DELIVERABILITY_SIGNAL_SOURCES,
	isDeliverabilitySignalSource,
	normalizeDeliverabilityRoutingSnapshot,
} from '../deliverabilityRouting';

const NOW = 1_800_000_000_000;

function snapshot(signals: unknown[], generatedAt = NOW) {
	return { generatedAt, signals };
}

describe('outcome-derived signal sources in the strict snapshot parser', () => {
	it('recognizes each new source as part of the union', () => {
		for (const source of OUTCOME_DELIVERABILITY_SIGNAL_SOURCES) {
			expect(isDeliverabilitySignalSource(source)).toBe(true);
			expect(DELIVERABILITY_SIGNAL_SOURCES).toContain(source);
		}
	});

	it('accepts every new source with the shipped shape', () => {
		for (const source of OUTCOME_DELIVERABILITY_SIGNAL_SOURCES) {
			const parsed = normalizeDeliverabilityRoutingSnapshot(
				snapshot([{ provider: 'gmail', source, severity: 'warning', observedAt: NOW }]),
				NOW
			);
			expect(parsed?.signals).toEqual([
				{ provider: 'gmail', source, severity: 'warning', observedAt: NOW },
			]);
		}
	});

	it('applies the shipped freshness rule to the new sources', () => {
		for (const source of OUTCOME_DELIVERABILITY_SIGNAL_SOURCES) {
			const stale = NOW - DELIVERABILITY_SNAPSHOT_MAX_AGE_MS - 1;
			expect(
				normalizeDeliverabilityRoutingSnapshot(
					snapshot([{ provider: 'all', source, severity: 'critical', observedAt: stale }]),
					NOW
				)
			).toBeNull();
			// A stale snapshot envelope is rejected whatever it carries.
			expect(
				normalizeDeliverabilityRoutingSnapshot(
					snapshot([{ provider: 'all', source, severity: 'critical', observedAt: stale }], stale),
					NOW
				)
			).toBeNull();
		}
	});

	it('applies the shipped future-skew rule to the new sources', () => {
		for (const source of OUTCOME_DELIVERABILITY_SIGNAL_SOURCES) {
			const skewed = NOW + DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS + 1;
			expect(
				normalizeDeliverabilityRoutingSnapshot(
					snapshot([{ provider: 'all', source, severity: 'critical', observedAt: skewed }], skewed),
					NOW
				)
			).toBeNull();
			// observedAt may never postdate the snapshot that carries it.
			expect(
				normalizeDeliverabilityRoutingSnapshot(
					snapshot([{ provider: 'all', source, severity: 'critical', observedAt: NOW + 1 }]),
					NOW
				)
			).toBeNull();
		}
	});

	it('rejects malformed signals carrying a new source', () => {
		const malformed: unknown[] = [
			{ provider: 'all', source: 'bounce_rate', severity: 'critical' },
			{ provider: 'all', source: 'bounce_rate', severity: 'fatal', observedAt: NOW },
			{ provider: 'nowhere', source: 'bounce_rate', severity: 'critical', observedAt: NOW },
			{ provider: 'all', source: 'bounce_rate', severity: 'critical', observedAt: '1' },
			{ provider: 'all', source: 'bounce_rate', severity: 'critical', observedAt: Number.NaN },
			{ provider: 'all', source: 'bounce_rate', severity: 'critical', observedAt: -1 },
			{
				provider: 'all',
				source: 'bounce_rate',
				severity: 'critical',
				observedAt: NOW,
				extra: true,
			},
			null,
			'bounce_rate',
		];
		for (const signal of malformed) {
			expect(normalizeDeliverabilityRoutingSnapshot(snapshot([signal]), NOW)).toBeNull();
		}
	});

	it('still rejects sources outside the widened union', () => {
		for (const source of ['spam_rate', 'placement', 'bounce', 'BOUNCE_RATE', '']) {
			expect(isDeliverabilitySignalSource(source)).toBe(false);
			expect(
				normalizeDeliverabilityRoutingSnapshot(
					snapshot([{ provider: 'all', source, severity: 'critical', observedAt: NOW }]),
					NOW
				)
			).toBeNull();
		}
	});

	it('rejects a whole snapshot when one outcome signal is bad', () => {
		expect(
			normalizeDeliverabilityRoutingSnapshot(
				snapshot([
					{ provider: 'all', source: 'dnsbl_listed', severity: 'critical', observedAt: NOW },
					{ provider: 'all', source: 'complaint_rate', severity: 'loud', observedAt: NOW },
				]),
				NOW
			)
		).toBeNull();
	});
});
