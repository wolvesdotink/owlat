import { describe, it, expect } from 'vitest';
import { renderButtonContent } from '../../blocks/button';
import { listModule } from '../../blocks/list';
import { renderVideoContent } from '../../blocks/video';
import { renderEmailHtml } from '../../renderer';
import type {
	ButtonBlockContent,
	CarouselBlockContent,
	EditorBlock,
	ListBlockContent,
	VideoBlockContent,
} from '@owlat/shared';
import type { RenderArgs, RenderContext } from '../../blocks/_module';

const listCtx = {} as RenderContext;
const renderListContent = (content: ListBlockContent): string => {
	const a: RenderArgs<'list'> = {
		block: { id: 'l', type: 'list', content },
		content,
		ctx: listCtx,
		width: 600,
		placement: 'root',
		walk: () => '',
	};
	return listModule.html(a);
};

/**
 * XSS regression tests for raw user-input interpolation in block renderers.
 *
 * The rendered email HTML is shipped to recipients AND to the public
 * "View in Browser" archive endpoint, so any unescaped user input here is a
 * stored-XSS surface affecting every viewer of every campaign.
 *
 * Coverage:
 *   - button.ts        — content.text (plain text → HTML body)
 *   - list.ts          — iconUrl (URL → src attribute)
 *   - video.ts         — thumbnailUrl, alt, videoUrl (URL/text → attributes)
 *   - carousel.ts      — img.linkUrl, img.src, img.alt, img.thumbnailSrc
 *
 * Each test feeds a payload that would break out of its context and asserts
 * the renderer escapes / sanitises rather than emitting the literal payload.
 */

const XSS_TEXT = '<script>alert(1)</script>';
const XSS_ATTR = '" onerror="alert(1)';
const XSS_PROTOCOL = 'javascript:alert(1)';

describe('XSS: button block', () => {
	const baseButton: ButtonBlockContent = {
		text: 'placeholder',
		url: 'https://example.com',
		backgroundColor: '#007bff',
		textColor: '#ffffff',
		align: 'center',
		borderRadius: 4,
		paddingX: 24,
		paddingY: 12,
	};

	it('escapes <script> tags in button text (HTML branch)', () => {
		const html = renderButtonContent({ ...baseButton, text: XSS_TEXT });
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	it('escapes <script> tags in VML branch (Outlook fallback)', () => {
		const html = renderButtonContent({ ...baseButton, text: XSS_TEXT });
		// VML branch is everything before the `<!--[if !mso]>` non-MSO marker.
		const msoBranch = html.split('<!--[if !mso]>')[0]!;
		expect(msoBranch).toContain('v:roundrect');
		expect(msoBranch).not.toContain('<script>alert(1)</script>');
		expect(msoBranch).toContain('&lt;script&gt;');
	});

	it('escapes <script> tags in VML gradient branch', () => {
		const html = renderButtonContent({
			...baseButton,
			text: XSS_TEXT,
			backgroundGradient: {
				type: 'linear',
				angle: 180,
				stops: [
					{ color: '#ff0000', position: 0 },
					{ color: '#00ff00', position: 100 },
				],
			},
		});
		const msoBranch = html.split('<!--[if !mso]>')[0]!;
		expect(msoBranch).toContain('v:fill');
		expect(msoBranch).not.toContain('<script>alert(1)</script>');
		expect(msoBranch).toContain('&lt;script&gt;');
	});
});

describe('XSS: list block', () => {
	const baseList: ListBlockContent = {
		items: ['one', 'two'],
		listType: 'icon',
	};

	it('sanitises javascript: protocol in iconUrl', () => {
		const html = renderListContent({ ...baseList, iconUrl: XSS_PROTOCOL });
		// sanitizeUrl returns '' for javascript:; the empty string then renders
		// as `src=""`, which is harmless.
		expect(html).not.toContain('javascript:');
	});

	it('escapes attribute-breakout payload in iconUrl', () => {
		const html = renderListContent({
			...baseList,
			iconUrl: `https://x.com/icon.png${XSS_ATTR}`,
		});
		// Attribute breakout would require an unescaped `"` followed by ` onerror=`.
		// The payload's literal `onerror=` may appear escaped *inside* a value; we just
		// need to ensure the quote that would close the attribute is escaped.
		expect(html).not.toContain('" onerror="');
	});

	it('still leaves a benign https iconUrl intact', () => {
		const html = renderListContent({
			...baseList,
			iconUrl: 'https://x.com/icon.png',
		});
		expect(html).toContain('src="https://x.com/icon.png"');
	});
});

describe('XSS: video block', () => {
	const baseVideo: VideoBlockContent = {
		thumbnailUrl: 'https://example.com/thumb.jpg',
		videoUrl: 'https://example.com/v',
		width: 600,
		align: 'center',
	};

	it('sanitises javascript: in thumbnailUrl', () => {
		const html = renderVideoContent({ ...baseVideo, thumbnailUrl: XSS_PROTOCOL }, 600);
		expect(html).not.toContain('javascript:');
	});

	it('sanitises javascript: in videoUrl', () => {
		const html = renderVideoContent({ ...baseVideo, videoUrl: XSS_PROTOCOL }, 600);
		expect(html).not.toContain('javascript:');
	});

	it('escapes attribute-breakout payload in alt text', () => {
		const html = renderVideoContent({ ...baseVideo, alt: XSS_ATTR }, 600);
		// Attribute breakout would require an unescaped `"` followed by ` onerror=`.
		// The payload's literal `onerror=` may appear escaped *inside* a value; we just
		// need to ensure the quote that would close the attribute is escaped.
		expect(html).not.toContain('" onerror="');
	});
});

describe('XSS: carousel block', () => {
	const makeCarouselBlock = (content: Partial<CarouselBlockContent>): EditorBlock => ({
		id: 'carousel-x',
		type: 'carousel',
		content: {
			images: [{ src: 'https://example.com/a.jpg', alt: 'a' }],
			...content,
		} as CarouselBlockContent,
	});

	it('sanitises javascript: in image src', () => {
		const html = renderEmailHtml(
			[
				makeCarouselBlock({
					images: [{ src: XSS_PROTOCOL, alt: 'a' }],
				}),
			],
			{ inlineCss: false }
		);
		expect(html).not.toContain('javascript:');
	});

	it('sanitises javascript: in image linkUrl', () => {
		const html = renderEmailHtml(
			[
				makeCarouselBlock({
					images: [{ src: 'https://example.com/a.jpg', alt: 'a', linkUrl: XSS_PROTOCOL }],
				}),
			],
			{ inlineCss: false }
		);
		expect(html).not.toContain('javascript:');
	});

	it('escapes attribute-breakout payload in image alt', () => {
		const html = renderEmailHtml(
			[
				makeCarouselBlock({
					images: [{ src: 'https://example.com/a.jpg', alt: XSS_ATTR }],
				}),
			],
			{ inlineCss: false }
		);
		// Attribute breakout would require an unescaped `"` followed by ` onerror=`.
		// The payload's literal `onerror=` may appear escaped *inside* a value; we just
		// need to ensure the quote that would close the attribute is escaped.
		expect(html).not.toContain('" onerror="');
	});

	it('sanitises javascript: in thumbnailSrc', () => {
		const html = renderEmailHtml(
			[
				makeCarouselBlock({
					thumbnailWidth: 60,
					images: [
						{ src: 'https://example.com/a.jpg', alt: 'a', thumbnailSrc: XSS_PROTOCOL },
					],
				}),
			],
			{ inlineCss: false }
		);
		expect(html).not.toContain('javascript:');
	});
});
