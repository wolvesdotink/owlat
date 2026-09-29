import { describe, it, expect } from 'vitest';
import { scanContent } from '../content/index.js';
import { extractUrls } from '../content/phishingUrls.js';
import {
	MAX_CONTENT_SCAN_CHARS,
	capContentScanInput,
	removeSpans,
	replaceTags,
} from '../content/htmlScan.js';

describe('extractUrls attribute handling', () => {
	it('reads href after other attributes, in any case', () => {
		expect(extractUrls('<A class="x" HREF="https://example.com/a">A</A>')).toEqual([
			{ href: 'https://example.com/a', text: 'A' },
		]);
	});

	it('reads href after a quoted value holding >', () => {
		expect(extractUrls('<a title="a > b" href="https://example.com/t">T</a>')).toEqual([
			{ href: 'https://example.com/t', text: 'T' },
		]);
	});

	it('uses the first href attribute and ignores data-href', () => {
		const urls = extractUrls(
			'<a data-href="https://a.example" href="https://b.example" href="https://c.example">x</a>'
		);
		expect(urls.map((u) => u.href)).toEqual(['https://b.example']);
	});

	it('accepts whitespace around =', () => {
		expect(extractUrls('<a href = "https://example.com/s">S</a>')[0]?.href).toBe(
			'https://example.com/s'
		);
	});

	it('strips tags from the link text', () => {
		expect(extractUrls('<a href="https://x.example"><b>bold</b> text</a>')[0]?.text).toBe(
			'bold text'
		);
	});

	it('reads a linked anchor nested in one without href', () => {
		expect(extractUrls('<a name="top"><a href="https://x.example">x</a>')).toEqual([
			{ href: 'https://x.example', text: 'x' },
		]);
	});

	it('returns every anchor in order', () => {
		const urls = extractUrls(
			'<p><a href="https://one.example">1</a> and <a href=\'https://two.example\'>2</a></p>'
		);
		expect(urls.map((u) => u.href)).toEqual(['https://one.example', 'https://two.example']);
	});

	it('skips anchors with no closing tag', () => {
		expect(extractUrls('<a href="https://x.example">never closed')).toEqual([]);
	});

	it('does not treat other tags starting with a as anchors', () => {
		expect(extractUrls('<abbr href="https://x.example">x</a>')).toEqual([]);
	});
});

describe('markup helpers', () => {
	it('replaceTags matches the plain tag regex', () => {
		for (const input of ['a<b>c', '<>x<y', '<<b>', 'a < b > c', 'x<a<b>y>z', '<']) {
			expect(replaceTags(input, ' ')).toBe(input.replace(/<[^>]+>/g, ' '));
		}
	});

	it('removeSpans matches the lazy block regex', () => {
		for (const input of [
			'a<style x>b</style>c<style>d</STYLE>e',
			'a<style>b',
			'a<style b</style>',
			'<style>1</style><style>2',
		]) {
			expect(removeSpans(input, /<style/gi, /<\/style>/gi, true)).toBe(
				input.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
			);
		}
		for (const input of ['a<!--b-->c<!---->d', '<!-->x-->', 'a<!--b']) {
			expect(removeSpans(input, /<!--/g, /-->/g, false)).toBe(
				input.replace(/<!--[\s\S]*?-->/g, '')
			);
		}
	});

	it('caps the scanned input length', () => {
		expect(capContentScanInput('a'.repeat(MAX_CONTENT_SCAN_CHARS + 10))).toHaveLength(
			MAX_CONTENT_SCAN_CHARS
		);
	});
});

describe('content scan helpers run in linear time on adversarial input', () => {
	const FIVE_MB = 5 * 1024 * 1024;
	const repeatTo = (unit: string, size = FIVE_MB) => unit.repeat(Math.ceil(size / unit.length));
	const BUDGET_MS = 1000;

	const timed = (fn: () => unknown): number => {
		const start = performance.now();
		fn();
		return performance.now() - start;
	};

	const shapes: Array<[string, string]> = [
		['unclosed anchors with href', '<a href="x" '],
		['closed anchor tags without </a>', '<a href="x">'],
		['anchors with unterminated quoted values', '<a x="'],
		['anchors with unterminated single-quoted values', "<a x='"],
		['tag openers', '<'],
		['unclosed style openers', '<style'],
		['unclosed script openers', '<script>'],
		['unclosed comments', '<!--'],
	];

	it.each(shapes)('extractUrls on 5 MB of %s', (_label, unit) => {
		const input = repeatTo(unit);
		expect(timed(() => extractUrls(input))).toBeLessThan(BUDGET_MS);
	});

	it('extractUrls on 5 MB of tag openers inside one anchor', () => {
		const input = `<a href="https://x.example">${repeatTo('<b ')}</a>`;
		expect(timed(() => extractUrls(input))).toBeLessThan(BUDGET_MS);
	});

	it.each(shapes)('scanContent on 5 MB of %s', (_label, unit) => {
		const input = repeatTo(unit);
		expect(timed(() => scanContent('subject', input, { from: 'a@example.com' }))).toBeLessThan(
			BUDGET_MS
		);
	});
});
