/**
 * Pure view-model helpers for the TLS-RPT delivery card.
 */
import { describe, it, expect } from 'vitest';
import { formatSuccessRate, successRateTone, toFailureRows } from '../tlsReportView';

describe('formatSuccessRate', () => {
	it('renders a whole-percent string', () => {
		expect(formatSuccessRate(1)).toBe('100%');
		expect(formatSuccessRate(0.955)).toBe('96%');
		expect(formatSuccessRate(0)).toBe('0%');
	});
	it('renders a dash when unknown', () => {
		expect(formatSuccessRate(null)).toBe('—');
	});
});

describe('successRateTone', () => {
	it('is neutral for unknown, success at ≥99%, warning ≥95%, error below', () => {
		expect(successRateTone(null)).toBe('neutral');
		expect(successRateTone(1)).toBe('success');
		expect(successRateTone(0.99)).toBe('success');
		expect(successRateTone(0.97)).toBe('warning');
		expect(successRateTone(0.5)).toBe('error');
	});
});

describe('toFailureRows', () => {
	it('maps types to plain-language copy, most-frequent first', () => {
		const rows = toFailureRows([
			{ type: 'certificate-host-mismatch', count: 2 },
			{ type: 'starttls-not-supported', count: 9 },
		]);
		expect(rows[0]).toEqual({
			type: 'starttls-not-supported',
			label: 'STARTTLS stripped upstream',
			count: 9,
		});
		expect(rows[1]!.label).toBe("Certificate didn't match the server name");
	});
});
