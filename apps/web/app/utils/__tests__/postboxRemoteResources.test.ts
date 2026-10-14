// @vitest-environment happy-dom
/**
 * Remote-resource consent over the real sanitizer output. Each bypass from
 * issue #1327 (CSS backgrounds, a srcset with no src, a data: src with a remote
 * srcset) must be withheld while images are blocked and seen by the tracker
 * count, and must still render once the user shows images.
 */
import { describe, expect, it } from 'vitest';
import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { applyPostboxImageConsent, type PostboxImageConsent } from '../postboxRemoteResources';

const LABEL = 'Image blocked';

function render(raw: string, consent: PostboxImageConsent) {
	return applyPostboxImageConsent(sanitizeHtml(raw, POSTBOX_SANITIZE_CONFIG), consent, LABEL);
}

/** Whether the gated output still references a remote resource anywhere. */
function stillRemote(html: string): boolean {
	return applyPostboxImageConsent(html, 'everything', LABEL).hasRemoteResources;
}

const CSS_SHORTHAND = '<div style="background:url(https://bg.example/hero.png) no-repeat">Hi</div>';
const CSS_IMAGE = '<td style="background-image:url(\'https://bg.example/cell.png\')">Hi</td>';
const SRCSET_ONLY = '<img srcset="https://img.example/a.png 1x, https://img.example/b.png 2x">';
const DATA_SRC_REMOTE_SRCSET =
	'<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" srcset="https://img.example/c.png 2x">';
const CSS_PIXEL =
	'<div style="background-image:url(https://pixel.example/open.gif);width:1px;height:1px"></div>';

describe('applyPostboxImageConsent — images blocked', () => {
	it('withholds a CSS background shorthand URL', () => {
		const out = render(CSS_SHORTHAND, 'blocked');
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).not.toContain('bg.example');
		expect(out.html).toContain('Hi');
		expect(stillRemote(out.html)).toBe(false);
	});

	it('withholds a CSS background-image URL', () => {
		const out = render(`<table><tr>${CSS_IMAGE}</tr></table>`, 'blocked');
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).not.toContain('bg.example');
	});

	it('replaces an image with only a remote srcset by the blocked stand-in', () => {
		const out = render(SRCSET_ONLY, 'blocked');
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).not.toContain('<img');
		expect(out.html).not.toContain('srcset');
		expect(out.html).toContain(LABEL);
		expect(stillRemote(out.html)).toBe(false);
	});

	it('keeps a data: src but drops its remote srcset', () => {
		const out = render(DATA_SRC_REMOTE_SRCSET, 'blocked');
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).toContain('src="data:image/gif;base64,');
		expect(out.html).not.toContain('img.example');
		expect(out.html).not.toContain('srcset');
	});

	it('withholds image-set strings and CSS-escaped urls the scheme check cannot read', () => {
		const out = applyPostboxImageConsent(
			'<div style="background-image:image-set(&quot;https://set.example/a.png&quot; 1x)">a</div>' +
				'<div style="background:\\75 rl(https://esc.example/b.png)">b</div>',
			'blocked',
			LABEL
		);
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).not.toContain('set.example');
		expect(out.html).not.toContain('esc.example');
	});

	it('does not split a declaration on a semicolon inside a quoted url', () => {
		const out = applyPostboxImageConsent(
			'<div style="color:red;background:url(&quot;https://semi.example/a;b.png&quot;)">x</div>',
			'blocked',
			LABEL
		);
		expect(out.html).not.toContain('semi.example');
		expect(out.html).toContain('color:red');
	});

	it('counts CSS and srcset trackers in the banner inventory', () => {
		const out = render(
			`${CSS_PIXEL}<img src="data:image/gif;base64,R0lGOD" srcset="https://click.list-manage.com/open 1x">`,
			'blocked'
		);
		expect(out.detection.pixelCount).toBe(2);
		expect(out.detection.trackerHosts).toEqual(['click.list-manage.com', 'pixel.example']);
	});

	it('keeps the background colour when it withholds the image layer', () => {
		const out = render(
			'<div style="background:#000 url(https://img.example/hero.png) no-repeat;color:#fff">News</div>',
			'blocked'
		);
		expect(out.html).not.toContain('img.example');
		expect(out.html).toMatch(/background:\s*#000 none no-repeat/);
		expect(out.html).toContain('color:#fff');
	});

	it('does not count an image-set type() as a remote URL', () => {
		const out = applyPostboxImageConsent(
			'<div style="background:image-set(&quot;data:image/png;base64,AAAA&quot; 1x type(&quot;image/png&quot;))">a</div>',
			'blocked',
			LABEL
		);
		expect(out.hasRemoteResources).toBe(false);
		expect(out.html).toContain('data:image/png;base64,AAAA');
	});

	it('leaves inline images, plain styles and text untouched', () => {
		const html =
			'<p style="font-family:&quot;Helvetica Neue&quot;, Arial;color:#333">Hello</p>' +
			'<img src="data:image/png;base64,iVBOR" alt="inline">';
		const out = render(html, 'blocked');
		expect(out.hasRemoteResources).toBe(false);
		expect(out.detection.pixelCount).toBe(0);
		expect(out.html).toContain('Helvetica Neue');
		expect(out.html).toContain('src="data:image/png;base64,iVBOR"');
	});
});

describe('applyPostboxImageConsent — images shown', () => {
	it('renders CSS backgrounds and srcset normally', () => {
		const out = render(`${CSS_SHORTHAND}${SRCSET_ONLY}${DATA_SRC_REMOTE_SRCSET}`, 'images');
		expect(out.html).toContain('url(https://bg.example/hero.png)');
		expect(out.html).toContain('https://img.example/a.png 1x');
		expect(out.html).toContain('https://img.example/c.png 2x');
		expect(out.html).not.toContain(LABEL);
		expect(out.detection.pixelCount).toBe(0);
	});

	it('keeps tracker resources stripped in every spelling', () => {
		const out = render(
			`${CSS_PIXEL}<p>Body</p>` +
				'<img src="https://cdn.example/photo.jpg" srcset="https://click.list-manage.com/open 2x" width="600">' +
				'<img src="https://tracker.example.com/open.gif" width="1" height="1">',
			'images'
		);
		expect(out.html).not.toContain('pixel.example');
		expect(out.html).not.toContain('list-manage.com');
		expect(out.html).not.toContain('tracker.example.com');
		expect(out.html).toContain('https://cdn.example/photo.jpg');
		expect(out.html).toContain('<p>Body</p>');
		expect(out.detection.pixelCount).toBe(3);
	});

	it('keeps the approved srcset candidates when one is a tracker', () => {
		const out = render(
			'<img srcset="https://cdn.example/photo.png 1x, https://click.list-manage.com/open.gif 2x">',
			'images'
		);
		expect(out.html).toContain('<img srcset="https://cdn.example/photo.png 1x">');
		expect(out.html).not.toContain('list-manage.com');
		expect(out.detection.pixelCount).toBe(1);
	});

	it('keeps an image whose tracker src is backed by an approved srcset', () => {
		const out = applyPostboxImageConsent(
			'<img src="https://click.list-manage.com/open.gif" srcset="https://cdn.example/photo.png 2x">',
			'images',
			LABEL
		);
		expect(out.html).toBe('<img srcset="https://cdn.example/photo.png 2x">');
	});

	it('sees a tracker whose scheme hides behind a tab', () => {
		const out = render(
			'<img src="https:&#9;//click.list-manage.com/open.gif" width="600">' +
				'<div style="background:url(https:&#9;//click.list-manage.com/bg.gif);width:1px;height:1px"></div>',
			'images'
		);
		expect(out.detection.pixelCount).toBe(2);
		expect(out.detection.trackerHosts).toEqual(['click.list-manage.com']);
		expect(out.html).not.toContain('list-manage.com');
	});

	it('loads trackers too once the user asks for everything', () => {
		const out = render(CSS_PIXEL, 'everything');
		expect(out.html).toContain('https://pixel.example/open.gif');
		expect(out.detection.pixelCount).toBe(1);
	});
});
