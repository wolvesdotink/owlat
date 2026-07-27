import { describe, expect, it } from 'vitest';
import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	DELIVERABILITY_STREAM_KEYS,
	DESTINATION_PROVIDER_KEYS,
	parseDeliverabilityCellKey,
} from '../deliverabilityRouting';
import { GOVERNED_MESSAGE_TYPES, isGovernedMessageType } from '../routingDispatch';

describe('deliverability cell key', () => {
	it('round-trips every (stream x destinationProvider) combination', () => {
		const cells = allDeliverabilityCells();
		expect(cells).toHaveLength(
			DELIVERABILITY_STREAM_KEYS.length * DESTINATION_PROVIDER_KEYS.length
		);
		const seen = new Set<string>();
		for (const cell of cells) {
			const key = deliverabilityCellKey(cell);
			expect(key).toBe(`${cell.stream}:${cell.destinationProvider}`);
			expect(seen.has(key)).toBe(false);
			seen.add(key);
			expect(parseDeliverabilityCellKey(key)).toEqual(cell);
		}
		expect(seen.size).toBe(cells.length);
	});

	it('rejects malformed keys', () => {
		// Non-string inputs are excluded by the parameter type, so this matrix is
		// the string-shaped surface: wrong separator count, unknown members of
		// either axis, the non-cell `all` provider slice, and any whitespace or
		// case variation — the parser folds nothing.
		const malformed = [
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
		];
		for (const value of malformed) {
			expect(parseDeliverabilityCellKey(value)).toBeNull();
		}
	});

	it('recognises exactly the shipped stream keys', () => {
		for (const stream of DELIVERABILITY_STREAM_KEYS) {
			expect(isGovernedMessageType(stream)).toBe(true);
		}
		for (const notAStream of ['all', 'marketing', 'txn', '', 'Campaign']) {
			expect(isGovernedMessageType(notAStream)).toBe(false);
		}
	});

	it('keeps the stream axis aliased to the shipped governed message types', () => {
		// Aliasing rather than re-declaring is the point: a fifth governed message
		// type widens the cell axis with it instead of silently missing rows.
		expect(DELIVERABILITY_STREAM_KEYS).toBe(GOVERNED_MESSAGE_TYPES);
		expect([...DELIVERABILITY_STREAM_KEYS].sort()).toEqual([
			'automation',
			'campaign',
			'transactional',
		]);
	});
});
