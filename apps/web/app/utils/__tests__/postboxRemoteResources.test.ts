// @vitest-environment happy-dom
/**
 * Remote-resource consent over the real sanitizer output. Each bypass from
 * issue #1327 (CSS backgrounds, a srcset with no src, a data: src with a remote
 * srcset) must be withheld while images are blocked and seen by the tracker
 * count, and must still render once the user shows images.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import type * as SharedTrackers from '@owlat/shared/postboxTrackers';
import { applyPostboxImageConsent, type PostboxImageConsent } from '../postboxRemoteResources';

// The failing-closed tests make the inventory throw on a marked element.
vi.mock('@owlat/shared/postboxTrackers', async (importOriginal) => {
	const actual = await importOriginal<typeof SharedTrackers>();
	return {
		...actual,
		elementTrackingHints: (context: Parameters<typeof actual.elementTrackingHints>[0]) => {
			if (context.width === 'fail-inventory') throw new RangeError('boom');
			return actual.elementTrackingHints(context);
		},
	};
});

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

	it('sees an image-set nested inside cross-fade', () => {
		const html =
			'<div style="background:#000 -webkit-cross-fade(image-set(&quot;https://click.list-manage.com/open.gif&quot; 1x),url(data:image/gif;base64,AAAA),50%);color:#fff">a</div>';
		const blocked = applyPostboxImageConsent(html, 'blocked', LABEL);
		expect(blocked.hasRemoteResources).toBe(true);
		expect(blocked.detection.trackerHosts).toEqual(['click.list-manage.com']);
		expect(blocked.html).not.toContain('list-manage.com');
		expect(blocked.html).toContain('background:#000 none');
		expect(blocked.html).toContain('color:#fff');
		const shown = applyPostboxImageConsent(html, 'images', LABEL);
		expect(shown.html).not.toContain('list-manage.com');
	});

	it('fails closed on any function nesting and keeps the ones that fetch nothing', () => {
		const out = applyPostboxImageConsent(
			'<div style="background:linear-gradient(red,blue), foo(bar(baz(&quot;https://deep.example/a.png&quot;)))">a</div>' +
				'<div style="background-image:image-set(/*&quot;*/&quot;https://cmt.example/b.png&quot; 1x)">b</div>',
			'blocked',
			LABEL
		);
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).not.toContain('deep.example');
		expect(out.html).not.toContain('cmt.example');
		expect(out.html).toContain('linear-gradient(red,blue)');
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

describe('applyPostboxImageConsent — hostile input stays linear', () => {
	it('parses a srcset with 100k commas quickly', () => {
		const html = `<img srcset="https://cdn.example/a${','.repeat(100_000)}b, https://cdn.example/p.png 2x">`;
		const started = performance.now();
		const out = applyPostboxImageConsent(html, 'blocked', LABEL);
		expect(performance.now() - started).toBeLessThan(250);
		expect(out.hasRemoteResources).toBe(true);
		expect(out.html).not.toContain('srcset');
		expect(out.html).toContain(LABEL);
	});

	it('tokenizes deeply nested and unterminated CSS quickly', () => {
		const style = `background:${'f('.repeat(20_000)}${'url(&quot;'.repeat(20_000)}`;
		const started = performance.now();
		const out = applyPostboxImageConsent(`<div style="${style}">x</div>`, 'blocked', LABEL);
		expect(performance.now() - started).toBeLessThan(250);
		expect(out.html).toContain('x');
	});
});

describe('applyPostboxImageConsent — CSS escapes', () => {
	it('keeps an escaped colour and reports no tracker', () => {
		const out = render('<div style="background-color:\\23 000;color:#fff">News</div>', 'blocked');
		expect(out.html).toContain('background-color:\\23 000');
		expect(out.html).toContain('color:#fff');
		expect(out.hasRemoteResources).toBe(false);
		expect(out.detection.pixelCount).toBe(0);
	});

	it('reads a CDN url with an escaped space as a normal image', () => {
		const html =
			'<div style="background:#fff url(https://cdn.example/hero\\ image.png) no-repeat">a</div>';
		const shown = applyPostboxImageConsent(html, 'images', LABEL);
		expect(shown.html).toContain('hero\\ image.png');
		expect(shown.detection.pixelCount).toBe(0);
		const blocked = applyPostboxImageConsent(html, 'blocked', LABEL);
		expect(blocked.hasRemoteResources).toBe(true);
		expect(blocked.html).toContain('background:#fff none no-repeat');
	});

	it('decodes escapes that spell a tracker url, host or string', () => {
		const out = applyPostboxImageConsent(
			'<div style="background:\\75 rl(https://click.list-manage\\2e com/a.gif)">a</div>' +
				'<div style="background:image-set(&quot;\\&quot;&quot; &quot;https://click.list-manage.com/b.gif&quot; 1x)">b</div>',
			'images',
			LABEL
		);
		expect(out.detection.pixelCount).toBe(2);
		expect(out.detection.trackerHosts).toEqual(['click.list-manage.com']);
		expect(out.html).not.toContain('list-manage');
	});
});

describe('applyPostboxImageConsent — large inventories', () => {
	const TRACKER = 'https://click.list-manage.com/open.gif';
	const embedded = (count: number) =>
		Array.from({ length: count }, () => '&quot;data:image/gif;base64,R0&quot; 2x').join(',');

	it('withholds the tracker among 150k embedded image-set candidates', () => {
		const html = `<div style="background:#000 image-set(&quot;${TRACKER}&quot; 1x,${embedded(150_000)})">a</div>`;
		const out = applyPostboxImageConsent(html, 'images', LABEL);
		expect(out.noRemote).toBe(false);
		expect(out.detection.trackerHosts).toEqual(['click.list-manage.com']);
		expect(out.html).not.toContain('list-manage');
		expect(out.html).toContain('background:#000 none');
	});

	it('withholds the tracker among 150k srcset candidates', () => {
		const candidates = Array.from({ length: 150_000 }, (_, i) => `data:image/gif;base64,R${i} 2x`);
		const out = applyPostboxImageConsent(
			`<img srcset="${TRACKER} 1x, ${candidates.join(', ')}">`,
			'images',
			LABEL
		);
		expect(out.detection.pixelCount).toBe(1);
		expect(out.html).not.toContain('list-manage');
		expect(out.html).toContain('data:image/gif;base64,R149999 2x');
	});

	it('classifies CSS urls on one element in linear time', () => {
		// Compare how the cost scales rather than racing a wall clock, which a
		// busy CI runner misses: 4x the URLs should cost about 4x the time,
		// where per-URL style rescans made it about 16x.
		const elementWith = (count: number) => {
			const urls = Array.from({ length: count }, (_, i) => `url(https://cdn.example/${i}.png)`);
			return `<div style="width:600px;height:400px;background:${urls.join(',')}">a</div>`;
		};
		const fastest = (html: string) => {
			let best = Number.POSITIVE_INFINITY;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				applyPostboxImageConsent(html, 'images', LABEL);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		const small = elementWith(8_000);
		const large = elementWith(32_000);
		fastest(small); // warm-up: JIT and parser
		expect(fastest(large) / fastest(small)).toBeLessThan(8);

		const out = applyPostboxImageConsent(large, 'images', LABEL);
		expect(out.hasRemoteResources).toBe(true);
		expect(out.detection.pixelCount).toBe(0);
	});
});

describe('applyPostboxImageConsent — failing closed', () => {
	afterEach(() => vi.restoreAllMocks());

	it('withholds every CSS and srcset resource of an element it cannot read', () => {
		const out = applyPostboxImageConsent(
			'<p style="color:red">Hello</p>' +
				'<img width="fail-inventory" src="https://cdn.example/a.png" style="background:url(https://cdn.example/b.png)" srcset="https://cdn.example/c.png 2x">' +
				'<div width="fail-inventory" style="background:#000 url(https://cdn.example/d.png)">Text</div>',
			'images',
			LABEL
		);
		expect(out.html).toBe('<p style="color:red">Hello</p><div width="fail-inventory">Text</div>');
		expect(out.hasRemoteResources).toBe(true);
		expect(out.detection.pixelCount).toBe(2);
		expect(out.noRemote).toBe(false);
	});

	it('pins the no-network policy when the body cannot be inventoried', () => {
		const createElement = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
			if (tag === 'template') throw new Error('boom');
			return createElement(tag);
		});
		const out = applyPostboxImageConsent(
			'<div style="background:url(https://click.list-manage.com/o.gif)">a</div>',
			'images',
			LABEL
		);
		expect(out.noRemote).toBe(true);
		expect(out.hasRemoteResources).toBe(true);
		expect(applyPostboxImageConsent('<p>x</p>', 'everything', LABEL).noRemote).toBe(false);
	});
});
