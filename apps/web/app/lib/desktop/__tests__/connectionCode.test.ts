import { describe, expect, it } from 'vitest';
import { formatConnectionCode, parseConnectionCode } from '../connectionCode';

describe('connectionCode', () => {
	it('round-trips a state nonce and one-time token', () => {
		const state = '4f2c1e9a-8b1d-4c5e-9f3a-2d7b6a1c0e8f';
		const ott = 'JhFwB41gGUnSexSJQEOAacfIrneIOR_e';
		expect(parseConnectionCode(formatConnectionCode(state, ott))).toEqual({ state, ott });
	});

	it('splits on the FIRST separator so a token containing ":" stays intact', () => {
		expect(parseConnectionCode('abc:tok:en')).toEqual({ state: 'abc', ott: 'tok:en' });
	});

	it('tolerates surrounding whitespace from clipboard copies', () => {
		expect(parseConnectionCode('  abc:def\n')).toEqual({ state: 'abc', ott: 'def' });
	});

	it('rejects input without a separator or with an empty half', () => {
		expect(parseConnectionCode('no-separator')).toBeNull();
		expect(parseConnectionCode(':token-only')).toBeNull();
		expect(parseConnectionCode('state-only:')).toBeNull();
		expect(parseConnectionCode('')).toBeNull();
	});
});
