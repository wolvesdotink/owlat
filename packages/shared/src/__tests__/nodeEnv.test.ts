import { describe, expect, it } from 'vitest';
import { readIntEnv } from '../nodeEnv';

const RANGE = { default: 10, min: 1, max: 100 };

describe('readIntEnv', () => {
	it.each([
		['unset', {}],
		['empty', { LIMIT: '' }],
		['whitespace-only', { LIMIT: '  \t ' }],
	])('uses the default when the value is %s', (_label, env: Record<string, string>) => {
		expect(readIntEnv(env, 'LIMIT', RANGE)).toBe(10);
	});

	it('reads a valid value, trimming surrounding whitespace', () => {
		expect(readIntEnv({ LIMIT: ' 42 ' }, 'LIMIT', RANGE)).toBe(42);
		expect(readIntEnv({ LIMIT: '+7' }, 'LIMIT', RANGE)).toBe(7);
		expect(readIntEnv({ LIMIT: '100' }, 'LIMIT', RANGE)).toBe(100);
	});

	it.each(['1e3', '10abc', '1.5', 'NaN', '0x10', 'ten', '- 5'])(
		'rejects the non-integer %j instead of reading a prefix',
		(value) => {
			expect(() => readIntEnv({ LIMIT: value }, 'LIMIT', RANGE)).toThrow(
				'LIMIT must be an integer between 1 and 100'
			);
		}
	);

	it.each(['0', '-1', '101'])('rejects the out-of-range value %s', (value) => {
		expect(() => readIntEnv({ LIMIT: value }, 'LIMIT', RANGE)).toThrow(
			`LIMIT must be an integer between 1 and 100, got "${value}"`
		);
	});

	it('throws a named error', () => {
		let caught: unknown;
		try {
			readIntEnv({ LIMIT: 'abc' }, 'LIMIT', RANGE);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe('InvalidEnvError');
		expect((caught as { key?: string }).key).toBe('LIMIT');
	});

	it('rejects integers beyond the safe range even without a max', () => {
		expect(() => readIntEnv({ LIMIT: '9007199254740993' }, 'LIMIT', { default: 1 })).toThrow(
			'LIMIT must be an integer, got'
		);
	});

	it('describes one-sided ranges', () => {
		expect(() => readIntEnv({ DELAY: '-1' }, 'DELAY', { default: 0, min: 0 })).toThrow(
			'DELAY must be an integer of at least 0'
		);
		expect(() => readIntEnv({ DELAY: '5' }, 'DELAY', { default: 0, max: 4 })).toThrow(
			'DELAY must be an integer of at most 4'
		);
	});
});
