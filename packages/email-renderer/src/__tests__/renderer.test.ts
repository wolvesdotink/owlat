import { describe, it, expect } from 'vitest';
import { renderEmailHtml, renderBlockFragment } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

const textBlock: EditorBlock = {
	id: '1',
	type: 'text',
	content: {
		html: '<p>Hello World</p>',
		blockType: 'paragraph',
		fontSize: 16,
		textColor: '#333333',
	},
};

const imageBlock: EditorBlock = {
	id: '2',
	type: 'image',
	content: {
		src: 'https://example.com/img.jpg',
		alt: 'Test',
		width: 100,
		align: 'center',
	},
};

const buttonBlock: EditorBlock = {
	id: '3',
	type: 'button',
	content: {
		text: 'Click Me',
		url: 'https://example.com',
		backgroundColor: '#007bff',
		textColor: '#ffffff',
		align: 'center',
		borderRadius: 4,
		paddingX: 24,
		paddingY: 12,
	},
};

const dividerBlock: EditorBlock = {
	id: '4',
	type: 'divider',
	content: {
		color: '#cccccc',
		thickness: 1,
		width: 100,
		style: 'solid',
	},
};

const spacerBlock: EditorBlock = {
	id: '5',
	type: 'spacer',
	content: {
		height: 32,
	},
};

describe('renderEmailHtml', () => {
	it('produces a complete HTML document', () => {
		const html = renderEmailHtml([textBlock]);
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('<html');
		expect(html).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
		expect(html).toContain('</html>');
		expect(html).toContain('<head>');
		expect(html).toContain('<body');
		expect(html).toContain('Hello World');
	});

	it('includes CSS resets in style block', () => {
		const html = renderEmailHtml([textBlock]);
		expect(html).toContain('<style>');
		expect(html).toContain('-webkit-text-size-adjust');
		expect(html).toContain('mso-table-lspace');
	});

	it('includes Outlook conditional comments', () => {
		const html = renderEmailHtml([textBlock]);
		expect(html).toContain('<!--[if mso]>');
		expect(html).toContain('<![endif]-->');
		expect(html).toContain('o:OfficeDocumentSettings');
	});

	it('uses 600px max-width wrapper', () => {
		const html = renderEmailHtml([textBlock]);
		expect(html).toContain('max-width:600px');
	});

	it('renders multiple blocks', () => {
		const html = renderEmailHtml([textBlock, imageBlock, buttonBlock, dividerBlock, spacerBlock]);
		expect(html).toContain('Hello World');
		expect(html).toContain('https://example.com/img.jpg');
		expect(html).toContain('Click Me');
		expect(html).toContain('border-top:1px solid #cccccc');
		expect(html).toContain('height:32px');
	});

	it('applies custom theme', () => {
		const html = renderEmailHtml([textBlock], {
			theme: {
				backgroundColor: '#f5f5f5',
				fontFamily: 'Georgia, serif',
			},
		});
		expect(html).toContain('background-color:#f5f5f5');
		expect(html).toContain('Georgia, serif');
	});

	it('applies dark mode styles with default colors', () => {
		const html = renderEmailHtml([textBlock], { darkMode: true });
		expect(html).toContain('background-color:#121212');
		expect(html).toContain('color:#e4e4e7');
	});

	it('applies custom dark mode theme colors', () => {
		const html = renderEmailHtml([textBlock], {
			darkMode: true,
			theme: {
				darkModeBackgroundColor: '#1e1e2e',
				darkModeTextColor: '#f0f0f0',
				darkModeLinkColor: '#80b0ff',
			},
		});
		expect(html).toContain('background-color:#1e1e2e');
		expect(html).toContain('color:#f0f0f0');
		expect(html).toContain('color:#80b0ff');
	});

	it('includes variable styles for personalization type', () => {
		const html = renderEmailHtml([textBlock], {
			variableType: 'personalization',
		});
		expect(html).toContain('personalization-variable');
	});

	it('includes variable styles for data type', () => {
		const html = renderEmailHtml([textBlock], { variableType: 'data' });
		expect(html).toContain('data-variable');
	});

	it('returns empty blocks area for empty array', () => {
		const html = renderEmailHtml([]);
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('</html>');
	});

	it('minifies output when requested', () => {
		const normal = renderEmailHtml([textBlock]);
		const minified = renderEmailHtml([textBlock], { minify: true });
		expect(minified.length).toBeLessThanOrEqual(normal.length);
		expect(minified).toContain('Hello World');
	});

	it('skips empty blocks', () => {
		const emptyImageBlock: EditorBlock = {
			id: 'empty',
			type: 'image',
			content: { src: '', alt: '', width: 100, align: 'center' },
		};
		const html = renderEmailHtml([emptyImageBlock]);
		expect(html).not.toContain('<img');
	});
});

describe('button section wrapper', () => {
	it('keeps the button fill off the full-width section wrapper', () => {
		const fragment = renderBlockFragment(buttonBlock);
		// The width:100% wrapper table must not carry the button's own
		// backgroundColor / borderRadius — that painted the whole section as one
		// giant button-colored band in preview while the editor showed a compact
		// centered button.
		const wrapperTag = fragment.slice(0, fragment.indexOf('>') + 1);
		expect(wrapperTag).toContain('width="100%"');
		expect(wrapperTag).not.toContain('background-color');
		expect(wrapperTag).not.toContain('border-radius');
		// The fill stays on the button itself.
		expect(fragment).toContain('background-color:#007bff');
		expect(fragment).toContain('border-radius:4px');
	});

	it('paints blockBackgroundColor (and only it) on the section wrapper', () => {
		const banded: EditorBlock = {
			...buttonBlock,
			content: { ...(buttonBlock.content as object), blockBackgroundColor: '#fef3c7' },
		} as EditorBlock;
		const fragment = renderBlockFragment(banded);
		const wrapperTag = fragment.slice(0, fragment.indexOf('>') + 1);
		expect(wrapperTag).toContain('background-color:#fef3c7');
		expect(wrapperTag).not.toContain('#007bff');
	});

	it('keeps a button gradient off the section wrapper', () => {
		const gradientButton: EditorBlock = {
			...buttonBlock,
			content: {
				...(buttonBlock.content as object),
				backgroundGradient: {
					type: 'linear',
					angle: 90,
					stops: [
						{ color: '#ff0000', position: 0 },
						{ color: '#0000ff', position: 100 },
					],
				},
			},
		} as EditorBlock;
		const fragment = renderBlockFragment(gradientButton);
		const wrapperTag = fragment.slice(0, fragment.indexOf('>') + 1);
		expect(wrapperTag).not.toContain('gradient');
	});
});

describe('renderBlockFragment', () => {
	it('returns HTML fragment without document wrapper', () => {
		const fragment = renderBlockFragment(textBlock);
		expect(fragment).not.toContain('<!DOCTYPE');
		expect(fragment).not.toContain('<html');
		expect(fragment).toContain('Hello World');
		expect(fragment).toContain('<table');
	});

	it('returns section-wrapped block', () => {
		const fragment = renderBlockFragment(buttonBlock);
		expect(fragment).toContain('Click Me');
		expect(fragment).toContain('table');
	});
});

describe('columns block', () => {
	it('renders columns with inline-block layout', () => {
		const columnsBlock: EditorBlock = {
			id: 'cols',
			type: 'columns',
			content: {
				columnCount: 2 as const,
				ratio: 'equal',
				mobileStacking: true,
				columns: [
					[
						{
							id: 'ci1',
							type: 'text',
							content: {
								html: '<p>Col 1</p>',
								blockType: 'paragraph',
								fontSize: 14,
								textColor: '#000',
							},
						},
					],
					[
						{
							id: 'ci2',
							type: 'text',
							content: {
								html: '<p>Col 2</p>',
								blockType: 'paragraph',
								fontSize: 14,
								textColor: '#000',
							},
						},
					],
				],
			},
		};
		const html = renderEmailHtml([columnsBlock]);
		expect(html).toContain('Col 1');
		expect(html).toContain('Col 2');
		expect(html).toContain('width:50%');
		expect(html).toContain('owlat-col');
		expect(html).toContain('display:inline-block');
	});
});

describe('social block', () => {
	it('renders social icons with alt-text placeholders', () => {
		const socialBlock: EditorBlock = {
			id: 'social',
			type: 'social',
			content: {
				links: [
					{ platform: 'twitter', url: 'https://x.com/test', enabled: true },
					{ platform: 'facebook', url: 'https://facebook.com/test', enabled: true },
					{ platform: 'instagram', url: '', enabled: true },
				],
				iconStyle: 'filled',
				align: 'center',
				iconSize: 32,
				iconSpacing: 8,
				iconColor: '#333333',
			},
		};
		const html = renderEmailHtml([socialBlock]);
		expect(html).toContain('https://x.com/test');
		expect(html).toContain('https://facebook.com/test');
		expect(html).not.toContain('data:image/svg+xml');
		expect(html).not.toContain('instagram'); // no URL, should be filtered
	});

	it('skips block when no enabled links', () => {
		const socialBlock: EditorBlock = {
			id: 'social',
			type: 'social',
			content: {
				links: [{ platform: 'twitter', url: 'https://x.com/test', enabled: false }],
				iconStyle: 'filled',
				align: 'center',
				iconSize: 32,
				iconSpacing: 8,
				iconColor: '#333333',
			},
		};
		const html = renderEmailHtml([socialBlock]);
		expect(html).not.toContain('x.com/test');
	});
});

describe('container block', () => {
	it('renders container with nested items using table layout', () => {
		const containerBlock: EditorBlock = {
			id: 'container',
			type: 'container',
			content: {
				items: [
					{
						id: 'ct1',
						type: 'text',
						content: {
							html: '<p>Inside container</p>',
							blockType: 'paragraph',
							fontSize: 14,
							textColor: '#000',
						},
					},
				],
				maxWidth: 80,
				paddingTop: 16,
				paddingRight: 24,
				paddingBottom: 16,
				paddingLeft: 24,
				paddingLinked: false,
				marginTop: 0,
				marginRight: 0,
				marginBottom: 0,
				marginLeft: 0,
				backgroundColor: '#f0f0f0',
				borderWidth: 1,
				borderColor: '#cccccc',
				borderStyle: 'solid',
				borderRadius: 8,
			},
		};
		const html = renderEmailHtml([containerBlock]);
		expect(html).toContain('Inside container');
		expect(html).toContain('background-color:#f0f0f0');
	});

	it('skips empty containers', () => {
		const emptyContainer: EditorBlock = {
			id: 'empty',
			type: 'container',
			content: {
				items: [],
				maxWidth: 100,
				paddingTop: 16,
				paddingRight: 24,
				paddingBottom: 16,
				paddingLeft: 24,
				paddingLinked: false,
				marginTop: 0,
				marginRight: 0,
				marginBottom: 0,
				marginLeft: 0,
				borderWidth: 0,
				borderColor: '#000000',
				borderStyle: 'none',
				borderRadius: 0,
			},
		};
		const html = renderEmailHtml([emptyContainer]);
		expect(html).not.toContain('Inside container');
	});
});

describe('accessibility', () => {
	it('sets lang="en" by default on <html>', () => {
		const html = renderEmailHtml([textBlock]);
		expect(html).toContain('lang="en"');
	});

	it('sets custom lang attribute', () => {
		const html = renderEmailHtml([textBlock], { lang: 'fr' });
		expect(html).toContain('lang="fr"');
	});

	it('adds scope="col" on table headers', () => {
		const tableBlock: EditorBlock = {
			id: 'tbl',
			type: 'table',
			content: {
				headers: ['Name', 'Price'],
				rows: [['Widget', '$10']],
				headerBackgroundColor: '#f5f5f5',
				headerTextColor: '#333',
				borderColor: '#ccc',
				striped: false,
				stripeColor: '#fafafa',
				cellPadding: 8,
				textAlign: 'left',
			},
		};
		const html = renderEmailHtml([tableBlock]);
		expect(html).toContain('scope="col"');
	});

	it('adds aria-label on image link', () => {
		const linkedImage: EditorBlock = {
			id: 'img-link',
			type: 'image',
			content: {
				src: 'https://example.com/photo.jpg',
				alt: 'Product photo',
				width: 100,
				align: 'center',
				linkUrl: 'https://example.com/product',
			},
		};
		const html = renderEmailHtml([linkedImage]);
		expect(html).toContain('aria-label="Product photo"');
	});
});

describe('mobileFontSize', () => {
	it('emits responsive font size rule inside media query', () => {
		const mobileTextBlock: EditorBlock = {
			id: 'mobile-text',
			type: 'text',
			content: {
				html: '<p>Responsive text</p>',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#333',
				mobileFontSize: 14,
			},
		};
		const html = renderEmailHtml([mobileTextBlock]);
		expect(html).toContain('[data-block-id="mobile-text"] div{font-size:14px!important}');
	});
});

describe('dark mode overrides', () => {
	it('applies owlat-dark-bg class and --dark-bg CSS var', () => {
		const darkBgBlock: EditorBlock = {
			id: 'dark-bg',
			type: 'text',
			content: {
				html: '<p>Dark BG</p>',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#333',
				darkBackgroundColor: '#1e1e1e',
			},
		};
		const html = renderEmailHtml([darkBgBlock]);
		expect(html).toContain('owlat-dark-bg');
		expect(html).toContain('--dark-bg:#1e1e1e');
	});

	it('applies owlat-dark-text class and --dark-text CSS var', () => {
		const darkTextBlock: EditorBlock = {
			id: 'dark-text',
			type: 'text',
			content: {
				html: '<p>Dark Text</p>',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#333',
				darkTextColor: '#f0f0f0',
			},
		};
		const html = renderEmailHtml([darkTextBlock]);
		expect(html).toContain('owlat-dark-text');
		expect(html).toContain('--dark-text:#f0f0f0');
	});
});

describe('buttonWidth', () => {
	it('applies px buttonWidth on CSS and table', () => {
		const btnBlock: EditorBlock = {
			id: 'btn-w',
			type: 'button',
			content: {
				text: 'Wide Button',
				url: 'https://example.com',
				backgroundColor: '#007bff',
				textColor: '#fff',
				align: 'center',
				borderRadius: 4,
				paddingX: 24,
				paddingY: 12,
				buttonWidth: '200px',
			},
		};
		const html = renderEmailHtml([btnBlock]);
		expect(html).toContain('width:200px');
		expect(html).toContain('width="200px"');
	});

	it('applies px buttonWidth on VML v:roundrect', () => {
		const btnBlock: EditorBlock = {
			id: 'btn-vml',
			type: 'button',
			content: {
				text: 'VML Button',
				url: 'https://example.com',
				backgroundColor: '#007bff',
				textColor: '#fff',
				align: 'center',
				borderRadius: 4,
				paddingX: 24,
				paddingY: 12,
				buttonWidth: '200px',
			},
		};
		const html = renderEmailHtml([btnBlock]);
		expect(html).toContain('v:roundrect');
		expect(html).toContain('style="width:200px"');
	});

	it('applies % buttonWidth on CSS but not VML', () => {
		const btnBlock: EditorBlock = {
			id: 'btn-pct',
			type: 'button',
			content: {
				text: 'Percent Button',
				url: 'https://example.com',
				backgroundColor: '#007bff',
				textColor: '#fff',
				align: 'center',
				borderRadius: 4,
				paddingX: 24,
				paddingY: 12,
				buttonWidth: '50%',
			},
		};
		const html = renderEmailHtml([btnBlock]);
		expect(html).toContain('width:50%');
		// VML v:roundrect should NOT have a width style for percentage
		const vmlMatch = html.match(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/);
		expect(vmlMatch).toBeTruthy();
		expect(vmlMatch![0]).not.toContain('style="width:');
	});
});

describe('link transform', () => {
	const transform = (url: string, ctx: { blockType: string; blockId: string }) =>
		`${url}?utm_source=email&block=${ctx.blockType}`;

	it('rewrites button URLs', () => {
		const html = renderEmailHtml([buttonBlock], { linkTransform: transform });
		// URL is HTML-escaped in href attributes (& becomes &amp;)
		expect(html).toContain('https://example.com?utm_source=email&amp;block=button');
	});

	it('rewrites image link URLs', () => {
		const linkedImage: EditorBlock = {
			id: 'img-lt',
			type: 'image',
			content: {
				src: 'https://example.com/img.jpg',
				alt: 'Photo',
				width: 100,
				align: 'center',
				linkUrl: 'https://example.com/product',
			},
		};
		const html = renderEmailHtml([linkedImage], { linkTransform: transform });
		expect(html).toContain('https://example.com/product?utm_source=email&amp;block=image');
	});

	it('rewrites text inline links', () => {
		const linkTextBlock: EditorBlock = {
			id: 'txt-lt',
			type: 'text',
			content: {
				html: '<p><a href="https://example.com/page">Click here</a></p>',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#333',
			},
		};
		const html = renderEmailHtml([linkTextBlock], { linkTransform: transform });
		expect(html).toContain('https://example.com/page?utm_source=email&amp;block=text');
	});

	it('rewrites social link URLs', () => {
		const socialBlock: EditorBlock = {
			id: 'soc-lt',
			type: 'social',
			content: {
				links: [{ platform: 'twitter', url: 'https://x.com/test', enabled: true }],
				iconStyle: 'filled',
				align: 'center',
				iconSize: 32,
				iconSpacing: 8,
				iconColor: '#333',
			},
		};
		const html = renderEmailHtml([socialBlock], { linkTransform: transform });
		expect(html).toContain('https://x.com/test?utm_source=email&amp;block=social');
	});

	it('rewrites menu link URLs', () => {
		const menuBlock: EditorBlock = {
			id: 'menu-lt',
			type: 'menu',
			content: {
				items: [{ label: 'Home', url: 'https://example.com' }],
				align: 'center',
			},
		};
		const html = renderEmailHtml([menuBlock], { linkTransform: transform });
		expect(html).toContain('https://example.com?utm_source=email&amp;block=menu');
	});

	it('rewrites video URLs', () => {
		const videoBlock: EditorBlock = {
			id: 'vid-lt',
			type: 'video',
			content: {
				thumbnailUrl: 'https://example.com/thumb.jpg',
				videoUrl: 'https://youtube.com/watch?v=123',
				alt: 'Video',
				width: 100,
				align: 'center',
			},
		};
		const html = renderEmailHtml([videoBlock], { linkTransform: transform });
		// `&` is escaped to `&amp;` in HTML attribute values (matches menu test above).
		// Pre-XSS-fix this URL was interpolated raw — the fix now escapes attributes.
		expect(html).toContain('https://youtube.com/watch?v=123?utm_source=email&amp;block=video');
	});
});

describe('render warnings', () => {
	it('collects accordion warning via onWarning callback', () => {
		const warnings: string[] = [];
		const accordionBlock: EditorBlock = {
			id: 'acc-w',
			type: 'accordion',
			content: {
				sections: [
					{
						id: 's1',
						title: 'Test',
						items: [
							{
								id: 't1',
								type: 'text',
								content: {
									html: '<p>Hi</p>',
									blockType: 'paragraph',
									fontSize: 14,
									textColor: '#000',
								},
							},
						],
					},
				],
			},
		};
		renderEmailHtml([accordionBlock], { onWarning: (w) => warnings.push(w) });
		expect(warnings.some((w) => w.includes('Accordion'))).toBe(true);
	});

	it('collects video warning via onWarning callback', () => {
		const warnings: string[] = [];
		const videoBlock: EditorBlock = {
			id: 'vid-w',
			type: 'video',
			content: {
				thumbnailUrl: 'https://example.com/thumb.jpg',
				videoUrl: 'https://youtube.com/watch?v=123',
				alt: 'Video',
				width: 100,
				align: 'center',
			},
		};
		renderEmailHtml([videoBlock], { onWarning: (w) => warnings.push(w) });
		expect(warnings.some((w) => w.includes('Video'))).toBe(true);
	});

	it('collects hamburger menu warning via onWarning callback', () => {
		const warnings: string[] = [];
		const menuBlock: EditorBlock = {
			id: 'menu-w',
			type: 'menu',
			content: {
				items: [{ label: 'Home', url: 'https://example.com' }],
				align: 'center',
				hamburgerOnMobile: true,
			},
		};
		renderEmailHtml([menuBlock], { onWarning: (w) => warnings.push(w) });
		expect(warnings.some((w) => w.includes('hamburgerOnMobile'))).toBe(true);
	});

	it('collects % buttonWidth warning via onWarning callback', () => {
		const warnings: string[] = [];
		const btnBlock: EditorBlock = {
			id: 'btn-ww',
			type: 'button',
			content: {
				text: 'Click',
				url: 'https://example.com',
				backgroundColor: '#007bff',
				textColor: '#fff',
				align: 'center',
				borderRadius: 4,
				paddingX: 24,
				paddingY: 12,
				buttonWidth: '50%',
			},
		};
		renderEmailHtml([btnBlock], { onWarning: (w) => warnings.push(w) });
		expect(warnings.some((w) => w.includes('percentage buttonWidth'))).toBe(true);
	});
});

describe('dark mode image swap', () => {
	it('renders two img tags with light and dark classes', () => {
		const darkImgBlock: EditorBlock = {
			id: 'dark-img',
			type: 'image',
			content: {
				src: 'https://example.com/light.jpg',
				alt: 'Logo',
				width: 100,
				align: 'center',
				darkSrc: 'https://example.com/dark.jpg',
			},
		};
		const html = renderEmailHtml([darkImgBlock]);
		expect(html).toContain('owlat-light-img');
		expect(html).toContain('owlat-dark-img');
		expect(html).toContain('src="https://example.com/light.jpg"');
		expect(html).toContain('src="https://example.com/dark.jpg"');
	});

	it('dark image has inline display:none', () => {
		const darkImgBlock: EditorBlock = {
			id: 'dark-img2',
			type: 'image',
			content: {
				src: 'https://example.com/light.jpg',
				alt: 'Logo',
				width: 100,
				align: 'center',
				darkSrc: 'https://example.com/dark.jpg',
			},
		};
		const html = renderEmailHtml([darkImgBlock]);
		// The dark img should have display:none in its inline style
		const darkImgMatch = html.match(/<img[^>]*owlat-dark-img[^>]*>/);
		expect(darkImgMatch).toBeTruthy();
		expect(darkImgMatch![0]).toContain('display:none');
	});

	it('style block has dark mode toggle rules', () => {
		const html = renderEmailHtml([textBlock]);
		expect(html).toContain('.owlat-light-img{display:block}');
		expect(html).toContain('.owlat-dark-img{display:none}');
		expect(html).toContain('prefers-color-scheme:dark');
		expect(html).toContain('.owlat-light-img{display:none!important}');
		expect(html).toContain('.owlat-dark-img{display:block!important}');
	});
});

describe('minification improvements', () => {
	it('preserves MSO conditional comments', () => {
		const html = renderEmailHtml([buttonBlock], { minify: true });
		expect(html).toContain('<!--[if mso]>');
		expect(html).toContain('<![endif]-->');
	});

	it('strips regular HTML comments', () => {
		const _normal = renderEmailHtml([textBlock]);
		const minified = renderEmailHtml([textBlock], { minify: true });
		// The minified output should not contain plain comments (if any exist)
		// Regular comments match <!--...-->  but NOT <!--[if or <![endif]
		const plainComments = minified.match(/<!--(?!\[if)(?!<!\[endif\])[\s\S]*?-->/g);
		expect(plainComments).toBeNull();
	});

	it('removes trailing semicolons in style attributes', () => {
		const minified = renderEmailHtml([textBlock], { minify: true });
		// After minification, style="...;" should become style="..."
		expect(minified).not.toMatch(/;"/);
	});
});

describe('column background images', () => {
	it('renders background-image and background-size on column with backgroundImage', () => {
		const colBlock: EditorBlock = {
			id: 'cols-bg',
			type: 'columns',
			content: {
				columnCount: 2 as const,
				ratio: 'equal',
				mobileStacking: true,
				columns: [
					[
						{
							id: 'c1',
							type: 'text',
							content: {
								html: '<p>Col 1</p>',
								blockType: 'paragraph',
								fontSize: 14,
								textColor: '#000',
							},
						},
					],
					[
						{
							id: 'c2',
							type: 'text',
							content: {
								html: '<p>Col 2</p>',
								blockType: 'paragraph',
								fontSize: 14,
								textColor: '#000',
							},
						},
					],
				],
				columnStyles: [{ backgroundImage: 'https://example.com/bg.jpg' }, {}],
			},
		};
		const html = renderEmailHtml([colBlock]);
		expect(html).toContain("background-image:url('https://example.com/bg.jpg')");
		expect(html).toContain('background-size:cover');
	});
});
