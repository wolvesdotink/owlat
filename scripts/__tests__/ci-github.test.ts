import { expect, it } from 'vitest';
import { jsonPages } from '../ci/github';
it('reads concatenated object and array API pages without treating string braces as syntax', () => {
	expect(jsonPages('{"jobs":[{"name":"a { \\\""}]}\n{"jobs":[]}')).toEqual([
		{ jobs: [{ name: 'a { "' }] },
		{ jobs: [] },
	]);
	expect(jsonPages('[{"x":1}]\n[{"x":2}]').flat()).toEqual([{ x: 1 }, { x: 2 }]);
	expect(() => jsonPages('{"jobs":[')).toThrow();
	expect(() => jsonPages('')).toThrow();
});
