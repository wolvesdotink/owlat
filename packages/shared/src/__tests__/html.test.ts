import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeHtmlWithBreaks, htmlToPlainText, replyBodyToHtml } from '../html';
import { htmlToPlainText as mailMessageHtmlToPlainText } from '@owlat/mail-message/text/htmlToPlainText';

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

describe('htmlToPlainText', () => {
	it('is the mail-message implementation, not a second copy', () => {
		expect(htmlToPlainText).toBe(mailMessageHtmlToPlainText);
	});

	it('drops style and decodes entities for API and web callers', () => {
		expect(htmlToPlainText('<style>p{color:red}</style><p>Tom &amp; Jerry</p>')).toBe(
			'Tom & Jerry'
		);
		expect(htmlToPlainText('<p>a</p><p>b</p>', { preserveBreaks: true })).toBe('a\n\nb');
	});
});
