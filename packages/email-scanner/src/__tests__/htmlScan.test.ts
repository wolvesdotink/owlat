import { describe, it, expect, vi } from 'vitest';
import { scanContent } from '../content/index.js';
import { contentRules } from '../content/rule.js';
import { HOSTILE_UNITS } from './hostileRegexInputs.js';
import { extractUrls } from '../content/phishingUrls.js';
import {
	MAX_CONTENT_SCAN_CHARS,
	capContentScanInput,
	removeSpans,
	replaceTags,
	scanAnchors,
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

	// The link scan is checked by counting the characters it reads, not
	// by timing it on a CI runner of unknown speed. It reads each character
	// once, plus at most one search to the end for each quote character a value
	// never closes, and the text of each anchor once more to drop its tags: at
	// most 4 per character. A scan that rereads the input reads thousands.
	const READS_PER_CHAR = 4;

	const shapes = HOSTILE_UNITS;

	/** Run the scan behind `extractUrls` and check what it read. */
	const expectLinearAnchorScan = (input: string) => {
		const meter = { chars: 0 };
		scanAnchors(input, meter);
		expect(meter.chars).toBeLessThanOrEqual(READS_PER_CHAR * input.length);
	};

	it('counts the characters the link scan reads', () => {
		const meter = { chars: 0 };
		scanAnchors('<a href="https://x.example"><b>x</b></a>', meter);
		expect(meter.chars).toBeGreaterThan(0);
	});

	it.each(shapes)('extractUrls on 5 MB of %s', (_label, unit) => {
		expectLinearAnchorScan(repeatTo(unit));
	});

	it('extractUrls on 5 MB of tag openers inside one anchor', () => {
		expectLinearAnchorScan(`<a href="https://x.example">${repeatTo('<b ')}</a>`);
	});

	// scanContent also runs every content rule, and those spend their time in
	// regular expressions, whose steps no meter can count. What the tests hold
	// is their input: no rule sees more than the scan cap, however long the
	// body. `bun run perf:bench` (family scan-content-scaling) times the rules
	// on the same bodies, filling the cap, at two sizes.
	it.each(HOSTILE_UNITS)(
		'scanContent on 5 MB of %s hands each rule at most the cap',
		(_l, unit) => {
			const rules = [...contentRules.values()];
			const seen: number[] = [];
			const spies = rules.map((rule) => {
				const scan = rule.scan.bind(rule);
				return vi.spyOn(rule, 'scan').mockImplementation((input) => {
					seen.push(input.html.length, input.text.length);
					return scan(input);
				});
			});
			try {
				const result = scanContent('subject', repeatTo(unit), { from: 'a@example.com' });
				expect(result.level).toBeDefined();
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			expect(seen).toHaveLength(2 * rules.length);
			expect(Math.max(...seen)).toBeLessThanOrEqual(MAX_CONTENT_SCAN_CHARS);
		}
	);
});
