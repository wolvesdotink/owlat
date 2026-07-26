import { describe, expect, it } from 'vitest';
import {
	allDeliverabilityCells,
	DELIVERABILITY_STREAM_KEYS,
	formatCellKey,
	isDeliverabilityCellKey,
	isDeliverabilityStream,
	parseCellKey,
} from '../deliverabilityCell';
import { DESTINATION_PROVIDER_KEYS } from '../deliverabilityRouting';

describe('deliverability cell key', () => {
	it('round-trips every (stream x destinationProvider) combination', () => {
		const cells = allDeliverabilityCells();
		expect(cells).toHaveLength(
			DELIVERABILITY_STREAM_KEYS.length * DESTINATION_PROVIDER_KEYS.length
		);
		const seen = new Set<string>();
		for (const cell of cells) {
			const key = formatCellKey(cell);
			expect(key).toBe(`${cell.stream}:${cell.destinationProvider}`);
			expect(seen.has(key)).toBe(false);
			seen.add(key);
			expect(parseCellKey(key)).toEqual(cell);
			expect(isDeliverabilityCellKey(key)).toBe(true);
		}
		expect(seen.size).toBe(cells.length);
	});

	it('rejects malformed keys', () => {
		const malformed: unknown[] = [
			'',
			':',
			'campaign',
			'gmail',
			'campaign:',
			':gmail',
			'campaign:gmail:extra',
			'campaign gmail',
			'campaign/gmail',
			'Campaign:gmail',
			'campaign:GMAIL',
			' campaign:gmail',
			'campaign:gmail ',
			'campaign:all',
			'marketing:gmail',
			'transactional:outlook',
			null,
			undefined,
			42,
			{ stream: 'campaign', destinationProvider: 'gmail' },
			['campaign', 'gmail'],
		];
		for (const value of malformed) {
			expect(parseCellKey(value)).toBeNull();
			expect(isDeliverabilityCellKey(value)).toBe(false);
		}
	});

	it('recognises exactly the shipped stream keys', () => {
		for (const stream of DELIVERABILITY_STREAM_KEYS) {
			expect(isDeliverabilityStream(stream)).toBe(true);
		}
		for (const notAStream of ['all', 'marketing', 'txn', '', 'Campaign']) {
			expect(isDeliverabilityStream(notAStream)).toBe(false);
		}
	});

	it('keeps the stream axis aligned with the shipped providerRoutes message types', () => {
		// providerRoutes.messageType is campaign | transactional | automation.
		expect([...DELIVERABILITY_STREAM_KEYS].sort()).toEqual([
			'automation',
			'campaign',
			'transactional',
		]);
	});
});
