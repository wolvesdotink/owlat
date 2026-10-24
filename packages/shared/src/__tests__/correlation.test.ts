import { describe, expect, it } from 'vitest';
import {
	CORRELATION_HEADER,
	correlationHeader,
	isCorrelationId,
	mintCorrelationId,
	readCorrelationId,
} from '../correlation';

describe('correlation ids', () => {
	it('accepts the ids Owlat mints and stores', () => {
		expect(isCorrelationId('txn_V1StGXR8_Z5jdHi6')).toBe(true);
		expect(isCorrelationId('dsp_0f3c2a9b8e7d4c1b')).toBe(true);
		expect(isCorrelationId('a'.repeat(128))).toBe(true);
	});

	it.each([
		['empty', ''],
		['too long', 'a'.repeat(129)],
		['leading separator', '-abc'],
		['whitespace', 'txn abc'],
		['header injection', 'txn_abc\r\nX-Evil: 1'],
		['quote', 'txn_"abc'],
		['non-string', 42],
	])('rejects a %s value', (_label, value) => {
		expect(isCorrelationId(value)).toBe(false);
	});

	it('reads a valid header and drops a malformed or missing one', () => {
		expect(readCorrelationId('txn_abc')).toBe('txn_abc');
		expect(readCorrelationId('not valid')).toBeUndefined();
		expect(readCorrelationId(null)).toBeUndefined();
		expect(readCorrelationId(undefined)).toBeUndefined();
	});

	it('mints a valid, prefixed, unique id', () => {
		const first = mintCorrelationId('pbx');
		const second = mintCorrelationId('pbx');
		expect(first).toMatch(/^pbx_[0-9a-f]{32}$/);
		expect(isCorrelationId(first)).toBe(true);
		expect(first).not.toBe(second);
	});

	it('carries the caller id in the header, else a minted one', () => {
		expect(correlationHeader('txn_abc', 'mta')).toEqual({ [CORRELATION_HEADER]: 'txn_abc' });
		const minted = correlationHeader(undefined, 'mta')[CORRELATION_HEADER];
		expect(minted).toMatch(/^mta_[0-9a-f]{32}$/);
		expect(CORRELATION_HEADER).toBe('x-owlat-correlation');
	});
});
