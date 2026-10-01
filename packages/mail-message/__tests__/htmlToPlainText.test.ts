/**
 * `htmlToPlainText` — the one HTML→text pass behind snippets, previews, search
 * excerpts, prompts, scans, the outbound text/plain part and the MTA's text
 * fallback.
 */

import { describe, it, expect } from 'vitest';
import { htmlToPlainText } from '../src/text/htmlToPlainText';
import * as mailMessage from '../src/index';

const fromRoot = mailMessage.htmlToPlainText;

/**
 * Verbatim copy of the retired `apps/api/convex/delivery/sendComposition/
 * plainText.ts`, the outbound text/plain generator `preserveBreaks` replaces.
 * Kept here only as the parity reference.
 */
function legacySendPlainText(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<\/h[1-6]>/gi, '\n\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<\/tr>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#039;/gi, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

describe('htmlToPlainText — default (collapsed) layout', () => {
	it.each([
		['plain tags become spaces', '<p>Hello</p><p>World</p>', 'Hello World'],
		['inline markup keeps words apart', 'a<b>b</b>c', 'a b c'],
		['style body dropped', '<style>.x{color:red}</style><p>Hi</p>', 'Hi'],
		['style with attributes dropped', '<style type="text/css" media="all">p{}</style>Hi', 'Hi'],
		['script body dropped', '<p>Hi</p><script>steal("x")</script>', 'Hi'],
		['uppercase tags dropped', '<SCRIPT>x()</SCRIPT><STYLE>y</STYLE>Hi', 'Hi'],
		['head with title dropped', '<html><head><title>T</title></head><body>Hi</body></html>', 'Hi'],
		['comment dropped', 'a<!-- secret -->b', 'a b'],
		['mso conditional dropped', '<!--[if mso]><p>Outlook only</p><![endif]-->Hi', 'Hi'],
		['downlevel-revealed content kept', '<!--[if !mso]><!--><p>Hi</p><!--<![endif]-->', 'Hi'],
		['empty comment forms', 'a<!-->b<!--->c', 'a b c'],
		['unterminated comment runs to the end', 'Hi<!-- never closed <p>x</p>', 'Hi'],
		['unterminated style runs to the end', 'Hi<style>p{color:red}', 'Hi'],
		['unterminated head keeps its content', '<head><p>Body</p>', 'Body'],
		['element names are matched whole', '<styles>a</styles><header>b</header>', 'a b'],
		['close tag with whitespace', '<script>x</script >Hi', 'Hi'],
		['named entities', '&amp; &lt; &gt; &quot; &apos; &#39;', "& < > \" ' '"],
		['case-insensitive named entities', 'AT&AMP;T', 'AT&T'],
		['decimal entity', '&#8364;5 &#039;q&#039;', "€5 'q'"],
		['hex entity', '&#x20AC; &#X41;', '€ A'],
		['astral code point', '&#128512;', '\u{1F600}'],
		['invalid code points become U+FFFD', '&#0;&#xD800;&#1114112;', '���'],
		['nbsp in every spelling is a space', 'a&nbsp;b&#160;c&#xa0;d e', 'a b c d e'],
		['single-pass decoding', '&amp;lt;b&amp;gt;', '&lt;b&gt;'],
		['decoded markup stays text', '&lt;script&gt;x&lt;/script&gt;', '<script>x</script>'],
		['unknown entities stay', '&copy; &foo; & alone', '&copy; &foo; & alone'],
		['a lone < is text', 'a < b and <3', 'a < b and <3'],
		['an unterminated tag at the end is dropped', 'Hi <a href="x', 'Hi'],
		['whitespace collapses and trims', '  <div>\n\t a  \n</div>  ', 'a'],
		['empty input', '', ''],
	])('%s', (_name, html, expected) => {
		expect(htmlToPlainText(html)).toBe(expected);
	});

	it('is the same function from the package root', () => {
		expect(fromRoot).toBe(htmlToPlainText);
	});

	it('has no second name: the stripHtml alias is gone from the package root', () => {
		expect('stripHtml' in mailMessage).toBe(false);
	});
});

describe('htmlToPlainText — preserveBreaks', () => {
	const pb = (html: string) => htmlToPlainText(html, { preserveBreaks: true });

	it.each([
		['paragraphs get a blank line', '<p>Hello</p><p>World</p>', 'Hello\n\nWorld'],
		['headings get a blank line', '<h1>Title</h1><h3>Sub</h3>Body', 'Title\n\nSub\n\nBody'],
		[
			'br, div, li, tr get a newline',
			'a<br>b<br/>c<br />d<div>e</div><li>f</li><tr>g</tr>h',
			'a\nb\nc\nde\nf\ng\nh',
		],
		['br with attributes', 'a<br class="x">b', 'a\nb'],
		['inline tags vanish without a space', '<b>H</b>ello', 'Hello'],
		['three or more newlines squeeze to two', '<p>a</p><p></p><p></p><p>b</p>', 'a\n\nb'],
		[
			'head, style, script and comments dropped',
			'<head><title>Subj</title><style>p{}</style></head><!--x--><p>Hi</p><script>s()</script>',
			'Hi',
		],
		['entities decoded after tags', '<p>1 &lt; 2 &amp;&amp; 3&nbsp;&gt; 2</p>', '1 < 2 && 3 > 2'],
		['horizontal whitespace is kept', '<p>a  b</p>', 'a  b'],
	])('%s', (_name, html, expected) => {
		expect(pb(html)).toBe(expected);
	});

	// The outbound text/plain part must not move: every composer shape the old
	// generator handled renders byte-identically.
	it.each([
		'<p>Hello</p><p>World</p>',
		'<p>Hello</p>',
		'<h1>Sale</h1><p>Shop <a href="https://shop.example">now</a></p>',
		'<div>Line one</div><div>Line two<br>continued</div>',
		'<ul><li>One</li><li>Two</li></ul><p>After</p>',
		'<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>',
		'<style>p{margin:0}</style><p>Styled &amp; decoded&nbsp;text</p>',
		'<p>Quote &quot;this&quot; &#039;that&#039; &lt;tag&gt;</p>',
		'<p>Hi Jane,</p>\n\n\n\n<p>Regards</p>',
		'<body><div><p>Nested</p></div></body>',
		'<script>x()</script><h2>Heading</h2><p>Para</p>',
		'   <p>  padded  </p>   ',
	])('matches the legacy send generator: %s', (html) => {
		expect(pb(html)).toBe(legacySendPlainText(html));
	});

	it('improves on the legacy generator where it leaked or double-decoded', () => {
		const html =
			'<html><head><title>Subject line</title></head><body><!--[if mso]>MSO<![endif]--><p>&amp;lt; &#8364;</p></body></html>';
		expect(legacySendPlainText(html)).toBe('Subject lineMSO< &#8364;');
		expect(pb(html)).toBe('&lt; €');
	});
});

describe('htmlToPlainText — linear on hostile input', () => {
	// Each shape defeats a naive pattern: `<[^>]+>` retried from every `<`, a
	// lazy `[\s\S]*?</script>` per unterminated opening tag, `<head>` with no
	// close, and entity look-alikes. 200k repetitions keep a quadratic scan in
	// the tens of seconds while a linear one stays in milliseconds.
	const N = 200_000;
	it.each([
		['bare <', '<'.repeat(N)],
		['open tag start', '<a'.repeat(N)],
		['unterminated scripts', '<script>'.repeat(N / 4)],
		['unterminated heads', '<head>'.repeat(N / 4)],
		['comment openers', '<!-'.repeat(N)],
		['br look-alikes', '<br '.repeat(N)],
		['closing look-alikes', '</p '.repeat(N)],
		['entity look-alikes', '&#1'.repeat(N)],
		['whitespace runs', `${' \n'.repeat(N)}x`],
		['nbsp runs', '&nbsp;  '.repeat(N / 4)],
	])('%s', (_name, input) => {
		for (const preserveBreaks of [false, true]) {
			const start = performance.now();
			htmlToPlainText(input, { preserveBreaks });
			expect(performance.now() - start).toBeLessThan(1000);
		}
	});
});
