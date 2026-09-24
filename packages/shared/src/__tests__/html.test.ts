import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeHtmlWithBreaks, replyBodyToHtml } from '../html';

describe('escapeHtml', () => {
	it('escapes all five metacharacters', () => {
		expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
			'&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;'
		);
	});
});

describe('escapeHtmlWithBreaks', () => {
	it('turns newlines into <br> after escaping', () => {
		expect(escapeHtmlWithBreaks('a < b\nc')).toBe('a &lt; b<br>c');
	});
});

describe('replyBodyToHtml', () => {
	it('wraps the escaped body in a div', () => {
		expect(replyBodyToHtml('Hi <there>')).toBe('<div>Hi &lt;there&gt;</div>');
	});

	it('gives CRLF and LF line endings one <br> each', () => {
		expect(replyBodyToHtml('one\r\ntwo\nthree')).toBe('<div>one<br>two<br>three</div>');
	});
});
