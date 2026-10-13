import { expect, it } from 'vitest';
import { jsonPages, isTransientAPIError } from '../ci/github';
it('reads concatenated object and array API pages without treating string braces as syntax', () => {
	expect(jsonPages('{"jobs":[{"name":"a { \\\""}]}\n{"jobs":[]}')).toEqual([
		{ jobs: [{ name: 'a { "' }] },
		{ jobs: [] },
	]);
	expect(jsonPages('[{"x":1}]\n[{"x":2}]').flat()).toEqual([{ x: 1 }, { x: 2 }]);
	expect(() => jsonPages('{"jobs":[')).toThrow();
	expect(() => jsonPages('')).toThrow();
});

it('retries transient HTTP failures without treating permissions or failed checks as transient', () => {
	expect(isTransientAPIError('HTTP 504')).toBe(true);
	expect(isTransientAPIError('HTTP 429')).toBe(true);
	expect(isTransientAPIError('HTTP 403')).toBe(false);
	expect(isTransientAPIError('Main CI failed')).toBe(false);
});
