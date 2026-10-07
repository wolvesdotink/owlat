/**
 * Hostile HTML for `segmentMessage`: the work counted through `options.work`
 * (characters read, open elements visited) must grow linearly with the input,
 * and element names that collide with Object.prototype must not break lookups.
 */
import { describe, expect, it } from 'vitest';
import { segmentMessage } from '../mailSegments';

const workFor = (html: string) => {
	const work = { chars: 0, steps: 0 };
	segmentMessage({ html }, { work });
	return work.chars + work.steps;
};

const SHAPES: Record<string, (k: number) => string> = {
	'repeated unclosed <head>': (k) => `${'<head>'.repeat(k)}<p>body</p>`,
	'repeated unclosed <script>': (k) => `<p>a</p>${'<script>'.repeat(k)}`,
	'repeated <title> with a late close': (k) => `${'<title>x</title><title>'.repeat(k)}`,
	'unmatched end tags over a deep stack': (k) => `${'<div>'.repeat(k)}${'</span>'.repeat(k)}`,
	'end tags matching deep in the stack': (k) => `${'<b><i>'.repeat(k)}${'</b>'.repeat(k)}`,
	'unterminated comments and declarations': (k) => `${'<!DOCTYPE x'.repeat(k)}<!--${'-'.repeat(k)}`,
	'quoted attributes with >': (k) => `${'<div title=">>>" class="a">t'.repeat(k)}`,
	'nested quote containers': (k) => `${'<div class="gmail_quote">x<br>'.repeat(k)}`,
	'nested attributed Gmail quotes': (k) =>
		'<div class="gmail_quote">On Mon, 5 Oct 2026 at 10:00, J <j@example.com> wrote:<blockquote>q'.repeat(
			k
		),
	'implicit closes and hidden formatting': (k) => '<p><b hidden>x<li>y<div>z</div></b>'.repeat(k),
	'nested blockquotes': (k) => `${'<blockquote>q'.repeat(k)}${'</blockquote>x'.repeat(k)}`,
};

describe('segmentMessage: linear work on hostile HTML', () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		it(name, () => {
			for (const k of [4_000, 8_000, 16_000]) {
				const html = shape(k);
				// A bounded number of reads per input character.
				expect(workFor(html), `${name} at ${k}`).toBeLessThanOrEqual(6 * html.length);
			}
			const small = workFor(shape(4_000));
			const large = workFor(shape(16_000));
			expect(large / small).toBeLessThan(5);
		});
	}
});

describe('segmentMessage: linear work on hostile plain text', () => {
	it('deepening > quote markers', () => {
		const shape = (k: number) =>
			Array.from({ length: k }, (_, d) => `${'>'.repeat(d % 200)} line ${d}`).join('\n');
		const work = (text: string) => {
			const meter = { chars: 0, steps: 0 };
			segmentMessage({ text }, { work: meter });
			return meter.chars + meter.steps;
		};
		for (const k of [1_000, 4_000]) {
			const text = shape(k);
			expect(work(text)).toBeLessThanOrEqual(6 * text.length);
		}
	});
});

describe('segmentMessage: names that collide with Object.prototype', () => {
	it('handles constructor, __proto__ and toString tags', () => {
		const html =
			'<constructor>Hi</constructor> <toString>there</toString> <__proto__>you</__proto__> <hasOwnProperty>ok</hasOwnProperty>';
		expect(() => segmentMessage({ html })).not.toThrow();
		const result = segmentMessage({ html });
		expect(result.canonicalText).toContain('Hi');
		expect(result.canonicalText).toContain('there');
		expect(result.canonicalText).toContain('ok');
	});

	it('handles header labels named like prototype members', () => {
		const text = 'Note.\n\nconstructor: x\ntoString: y\n__proto__: z\nhasOwnProperty: w\n';
		expect(() => segmentMessage({ text })).not.toThrow();
		expect(segmentMessage({ text }).segments.map((s) => s.kind)).toEqual(['fresh']);
	});
});
