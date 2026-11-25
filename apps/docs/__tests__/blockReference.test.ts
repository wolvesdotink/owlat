import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBlockReference, pagePath } from '../scripts/blockReference';

describe('the block content reference', () => {
	it.each(['en', 'de'] as const)(
		'%s: the field tables, examples, column widths and HTML policy are what their sources generate',
		(locale) => {
			const page = readFileSync(pagePath(locale), 'utf8');
			expect(generateBlockReference(page, locale)).toBe(page);
		}
	);

	it('fails a page that lost a generated part', () => {
		const page = readFileSync(pagePath('en'), 'utf8').replace(
			'<!-- /block-reference:text-html -->',
			''
		);
		expect(() => generateBlockReference(page, 'en')).toThrow(/text-html/);
	});
});
