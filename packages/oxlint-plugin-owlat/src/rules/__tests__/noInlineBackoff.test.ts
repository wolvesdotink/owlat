import rule from '../noInlineBackoff.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'apps/api/convex/mail/retry.ts';
const message =
	'Inline exponential backoff: declare a RetryPolicy and compute the wait with nextDelay from @owlat/shared/retryPolicy.';
const error = [{ message }];

ruleTester.run('owlat/no-inline-backoff', rule, {
	valid: [
		{
			name: 'the policy module computes the curve',
			filename: 'packages/shared/src/retryPolicy.ts',
			code: 'export const curve = (base: number, factor: number, n: number) => base * factor ** n;',
		},
		{
			name: 'a test may compute an expected delay',
			filename: 'apps/api/convex/mail/__tests__/retry.test.ts',
			code: 'export const expected = (n: number) => 1_000 * 2 ** n;',
		},
		{
			name: 'a constant exponent',
			filename,
			code: 'export const MAX = 2 ** 31 - 1;\nexport const GIB = 2 ** 30;\nexport const sq = (x: number) => x ** 2;',
		},
		{
			name: 'a half-life decay has a negated exponent',
			filename,
			code: 'export const decay = (age: number, halfLife: number) => Math.pow(2, -age / halfLife) + 2 ** -(age / halfLife);',
		},
		{
			name: 'a base below or at 1',
			filename,
			code: 'export const p = (n: number) => 0.05 ** (1 / n) + Math.pow(1 - 0.1, n) + 1 ** n;',
		},
		{
			name: 'powers of ten scale decimals',
			filename,
			code: 'export const scale = (digits: number) => 10 ** digits;',
		},
		{
			name: 'a base whose name is no growth factor',
			filename,
			code: 'export const size = (k: number, i: number) => Math.pow(k, i);',
		},
		{
			name: 'a local Math that shadows the global',
			filename,
			code: 'const Math = { pow: (a: number, b: number) => a + b };\nexport const x = (n: number) => Math.pow(2, n);',
		},
		{
			name: 'a doubling that is not a wait',
			filename,
			code: 'let pageSize = 10;\nexport function grow() { pageSize = Math.min(pageSize * 2, 500); }',
		},
		{
			name: 'a wait capped without scaling itself',
			filename,
			code: 'let delayMs = 0;\nexport function set(next: number) { delayMs = Math.min(next * 2, 500); }',
		},
		{
			name: 'a wait scaled by one or a fraction',
			filename,
			code: 'let delay = 1;\nexport function f() { delay *= 1; delay *= 0.5; delay = Math.min(delay * 0.5, 9); }',
		},
	],
	invalid: [
		{
			name: 'a doubling from an attempt count',
			filename,
			code: 'export const wait = (attempt: number) => 1_000 * 2 ** attempt;',
			errors: error,
		},
		{
			name: 'a capped curve with shifted indexing',
			filename,
			code: 'export const wait = (n: number) => Math.min(60_000 * 2 ** Math.max(0, n - 1), 3_600_000);',
			errors: error,
		},
		{
			name: 'Math.pow with a literal factor',
			filename,
			code: 'export const wait = (attempt: number) => Math.min(30_000 * Math.pow(4, attempt), 7_200_000);',
			errors: error,
		},
		{
			name: 'Math.pow with a base named as a multiplier',
			filename,
			code: 'export const wait = (backoffMultiplier: number, n: number) => 100 * Math.pow(backoffMultiplier, n);',
			errors: error,
		},
		{
			name: 'a base named as a growth factor',
			filename,
			code: 'export const wait = (policy: { factor: number }, n: number) => 100 * policy.factor ** n;',
			errors: error,
		},
		{
			name: 'a wait doubled in state up to a cap',
			filename,
			code: 'let delay = 1_000;\nexport function fail() { delay = Math.min(delay * 2, 60_000); }',
			errors: error,
		},
		{
			name: 'a member wait doubled with the operands and arguments swapped',
			filename,
			code: 'export class C { backoffMs = 5; fail() { this.backoffMs = Math.min(300_000, 2 * this.backoffMs); } }',
			errors: error,
		},
		{
			name: 'a retry wait multiplied in place',
			filename,
			code: 'let retryMs = 2_000;\nexport function fail() { retryMs *= 2; }',
			errors: error,
		},
	],
});
