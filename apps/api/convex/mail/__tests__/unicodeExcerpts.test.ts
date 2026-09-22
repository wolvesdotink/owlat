import { describe, expect, it } from 'vitest';
import { buildSnippet } from '../deliveryPipeline/insert';
import { buildSearchBody } from '../searchBody';

for (const [name, build, limit] of [
	['snippet', buildSnippet, 200],
	['search body', buildSearchBody, 8000],
] as const) {
	describe(name, () => {
		it.each([false, true])('preserves an emoji at the truncation boundary (HTML: %s)', (html) => {
			const prefix = 'a'.repeat(limit - 1) + '😀';
			const body = prefix + 'trailing';
			const result = html ? build(undefined, `<p>${body}</p>`) : build(body, undefined);
			expect(result).toBe(prefix);
			expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
		});

		it('counts astral characters as one code point each', () => {
			expect(build('😀'.repeat(limit + 1), undefined)).toBe('😀'.repeat(limit));
		});
	});
}

it('only backs up to a nearby word boundary, measured in code points', () => {
	const prefix = '😀'.repeat(7900);
	expect(buildSearchBody(`${prefix} ${'a'.repeat(200)}`, undefined)).toBe(
		`${prefix} ${'a'.repeat(99)}`
	);
	expect(buildSearchBody(`${'😀'.repeat(7980)} ${'a'.repeat(100)}`, undefined)).toBe(
		'😀'.repeat(7980)
	);
});

it('preserves a complete body at the limit without dropping its last word', () => {
	const body = `${'😀'.repeat(7998)} a`;
	expect(buildSearchBody(body, undefined)).toBe(body);
});
