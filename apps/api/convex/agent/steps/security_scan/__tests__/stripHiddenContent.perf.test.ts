/**
 * `stripHiddenContent` and `detectSmuggling` stay linear in their input on
 * adversarial HTML (GHSA-v4gq-pq2j-3pcj, #1163, #1315). The strip is checked by
 * counting its work through the scan meter; the regex-bound cases keep a wide
 * time budget. Behaviour tests live in `stripHiddenContent.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { detectSmuggling, MAX_SCAN_INPUT_CHARS, stripHiddenContent } from '../patterns';

describe('scan helpers run in linear time on adversarial input', () => {
	const FIVE_MB = 5 * 1024 * 1024;
	const repeatTo = (unit: string) => unit.repeat(Math.ceil(FIVE_MB / unit.length));

	// The strip is checked by counting its work (#1315), not by timing it: a
	// shared CI runner is 8-17 times slower than a developer machine and its
	// speed varies (#1163). Per character scanned (input past the cap is
	// dropped first), the comment pass reads each character once and the
	// element pass at most three times: once, plus at most one search to the
	// end of the input for each quote character a value never closes. The
	// stack and formatting-list work is a small constant per character; the
	// formatting reopen case needs the most, about 6. A scan that rereads the
	// input, or walks a list that grows with it, does thousands per character.
	const CHARS_PER_CHAR = 4;
	const STEPS_PER_CHAR = 8;

	/** Strip `input` as HTML and check the work stayed within the bounds above. */
	const stripMetered = (input: string): string => {
		const meter = { chars: 0, steps: 0 };
		const out = stripHiddenContent(input, { html: true, meter });
		const scanned = Math.min(input.length, MAX_SCAN_INPUT_CHARS);
		expect(meter.chars, 'characters read').toBeLessThanOrEqual(CHARS_PER_CHAR * scanned);
		expect(meter.steps, 'stack and list steps').toBeLessThanOrEqual(STEPS_PER_CHAR * scanned);
		return out;
	};

	it('counts the work of a scan', () => {
		const meter = { chars: 0, steps: 0 };
		stripHiddenContent('<p><b hidden>x</p>y</b>z', { html: true, meter });
		expect(meter.chars).toBeGreaterThan(0);
		expect(meter.steps).toBeGreaterThan(0);
		// Input past the cap is not read.
		const capped = { chars: 0, steps: 0 };
		stripHiddenContent('a'.repeat(MAX_SCAN_INPUT_CHARS + 10), { html: true, meter: capped });
		expect(capped.chars).toBe(2 * MAX_SCAN_INPUT_CHARS);
	});

	it.each([
		['unclosed styled tags', '<a style="x">'],
		['unclosed hidden tags', '<b style="display:none">'],
		['unclosed script openers', '<script>'],
		['unclosed style openers', '<style>'],
		['unclosed comments', '<!--'],
		['nested tag openers', '<a x '],
		['unterminated quoted attribute values', '<a x="'],
		['quoted attribute values holding >', `<b style='display:none;>' `],
		['colour values without a closing paren', '<i style="color:rgba(1'],
		['end tags with quoted attributes', `</b x='>' `],
		['unclosed raw-text elements', '<textarea>'],
		['unclosed titles and scripts', '<title><script>'],
		['hidden elements closed by attributes end tags', '<i style="display:none">x</i y>'],
		// These go through the tree builder's repair paths: reopening formatting
		// elements, adoption, implied end tags.
		['formatting elements taken out of the tree', '<b hidden><div>x</b>'],
		['nested tables and cells', '<table><tr><td hidden><table>'],
		['SVG content that HTML breaks out of', '<svg><g><p hidden>x'],
		['headings closing headings', '<h1 hidden><h2>x'],
		['links closing links', '<a hidden>x<a>'],
	])('stripHiddenContent on 5 MB of %s', (_label, unit) => {
		stripMetered(repeatTo(unit));
	});

	it('stripHiddenContent on 5 MB of formatting elements reopened after every close', () => {
		// Every close reopens the last 16 of the 40 formatting elements.
		const prefix = `<div>${Array.from({ length: 40 }, (_, i) => `<b x${i}>`).join('')}`;
		stripMetered(prefix + repeatTo('</div><div>x'));
	});

	it('stripHiddenContent on a deep stack with end tags that close nothing', () => {
		const n = Math.floor((MAX_SCAN_INPUT_CHARS - 8) / 10);
		const input = `<b><div>${'<span>'.repeat(n)}${'</b>'.repeat(n)}`;
		expect(input.length).toBeLessThanOrEqual(MAX_SCAN_INPUT_CHARS);
		stripMetered(input);
	});

	it('stripHiddenContent on 5 MB of tags after unterminated quoted values', () => {
		stripMetered(`<a x="<b y='${repeatTo('<i s=t ')}`);
	});

	it('stripHiddenContent on many distinct unclosed hidden tag names', () => {
		const parts: string[] = [];
		for (let i = 0; parts.length * 30 < FIVE_MB; i++) parts.push(`<t${i} style="display:none">`);
		stripMetered(parts.join(''));
	});

	// The cases below spend their time inside regular expressions (decoding a
	// style value, the detection patterns), whose steps no meter can count, so
	// they keep a time budget. It is over 100 times what they take on a
	// developer machine (25-45 ms), so a CI runner meets it with room to spare,
	// while a regex that backtracks over a value this long takes minutes.
	const REGEX_BUDGET_MS = 5000;

	const timed = (fn: () => unknown): number => {
		const start = performance.now();
		fn();
		return performance.now() - start;
	};

	// These fit under the scan cap, so the whole input is processed.
	const fitted = (unit: string, overhead: number) =>
		unit.repeat(Math.floor((MAX_SCAN_INPUT_CHARS - overhead) / unit.length));

	it.each([
		['character references', '&#58;'],
		['long numeric references', '&#x0000000000000000003a;'],
		['CSS escapes and comments', '\\6e /**/'],
		['unclosed CSS comments', '/*'],
	])('stripHiddenContent on a style attribute as long as the scan cap of %s', (_label, unit) => {
		const input = `<a style="${fitted(unit, 32)}">SECRETPAYLOAD</a>`;
		expect(input.length).toBeLessThanOrEqual(MAX_SCAN_INPUT_CHARS);
		let out = '';
		expect(timed(() => (out = stripMetered(input)))).toBeLessThan(REGEX_BUDGET_MS);
		// The value was read (and did not hide the element).
		expect(out).toContain('SECRETPAYLOAD');
	});

	it.each([
		['unclosed instruction comments', '<!-- ignore '],
		['colour values in one unterminated style attribute', 'color:rgba(1'],
	])('detectSmuggling on 5 MB of %s', (_label, unit) => {
		const input = `<p style="${repeatTo(unit)}`;
		expect(timed(() => detectSmuggling(input))).toBeLessThan(REGEX_BUDGET_MS);
	});
});
