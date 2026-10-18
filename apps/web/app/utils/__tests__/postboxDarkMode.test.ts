import { describe, it, expect } from 'vitest';
import {
	adaptEmailHtml,
	buildBaseStyle,
	classifyEmailHtml,
	contrastRatio,
	isReadableOnDark,
	lightenForDark,
	parseCssColor,
	relativeLuminance,
	remapInlineColorsForDark,
	POSTBOX_DARK_PALETTE,
} from '../postboxDarkMode';

describe('parseCssColor', () => {
	it('parses 6-digit hex', () => {
		expect(parseCssColor('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60, a: 1 });
	});

	it('parses 3-digit hex', () => {
		expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
	});

	it('parses rgb() and rgba()', () => {
		expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
		expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
	});

	it('parses common named colors and transparent', () => {
		expect(parseCssColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseCssColor('transparent')?.a).toBe(0);
	});

	it('returns null for unparseable values', () => {
		expect(parseCssColor('var(--x)')).toBeNull();
		expect(parseCssColor('linear-gradient(red, blue)')).toBeNull();
	});
});

describe('luminance / contrast', () => {
	it('computes relative luminance bounds', () => {
		expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
		expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBe(1);
	});

	it('black vs white is 21:1', () => {
		expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(
			21,
			1
		);
	});

	it('near-black text is unreadable on the dark background, white is readable', () => {
		expect(isReadableOnDark(parseCssColor('#1a1a1a')!)).toBe(false);
		expect(isReadableOnDark(parseCssColor('#ffffff')!)).toBe(true);
	});

	it('lightenForDark yields a readable color that keeps some hue', () => {
		const out = lightenForDark(parseCssColor('#550000')!);
		expect(isReadableOnDark(out)).toBe(true);
		expect(out.r).toBeGreaterThan(out.g); // still reddish
	});

	it('lightenForDark lifts a hue to AA contrast, not just the 3:1 cut-off', () => {
		const bg = parseCssColor(POSTBOX_DARK_PALETTE.background)!;
		const out = lightenForDark(parseCssColor('#003399')!);
		expect(contrastRatio(out, bg)).toBeGreaterThanOrEqual(4.5);
	});

	it('lightenForDark maps grays to the palette text color', () => {
		const text = parseCssColor(POSTBOX_DARK_PALETTE.text);
		expect(lightenForDark(parseCssColor('#000000')!)).toEqual(text);
		expect(lightenForDark(parseCssColor('#333333')!)).toEqual(text);
	});
});

describe('parseCssColor functional notations', () => {
	it('parses percentage and space-separated rgb()', () => {
		expect(parseCssColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
		expect(parseCssColor('rgb(255 255 255 / 50%)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
	});

	it('parses hsl() and hsla()', () => {
		expect(parseCssColor('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseCssColor('hsl(120deg 100% 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 1 });
		expect(parseCssColor('hsla(240, 100%, 50%, 0.5)')).toEqual({ r: 0, g: 0, b: 255, a: 0.5 });
	});

	it('rejects malformed functions', () => {
		expect(parseCssColor('rgb(10, 20)')).toBeNull();
		expect(parseCssColor('hsl(10, 20, 30)')).toBeNull();
		expect(parseCssColor('rgb(var(--x))')).toBeNull();
	});
});

describe('classifyEmailHtml', () => {
	it('plain paragraphs classify as simple', () => {
		const html = '<p>Hi there,</p><p>See you <b>tomorrow</b> at 10.</p><p>Best,<br>Ana</p>';
		expect(classifyEmailHtml(html)).toBe('simple');
	});

	it('bgcolor table mail classifies as designed', () => {
		const html = '<table bgcolor="#ffffff" width="600"><tr><td>Big sale!</td></tr></table>';
		expect(classifyEmailHtml(html)).toBe('designed');
	});

	it('explicit non-transparent background on a container classifies as designed', () => {
		const html = '<div style="background-color:#f4f4f4;padding:20px">Newsletter</div>';
		expect(classifyEmailHtml(html)).toBe('designed');
	});

	it('background-image on a container classifies as designed', () => {
		const html = `<td style="background-image:url('https://x.test/hero.png')">Hero</td>`;
		expect(classifyEmailHtml(html)).toBe('designed');
	});

	it('transparent backgrounds do not flip to designed', () => {
		const html = '<div style="background-color:transparent"><p>plain</p></div>';
		expect(classifyEmailHtml(html)).toBe('simple');
	});

	it('inline color on text (no container background) stays simple', () => {
		const html = '<p style="color:#333333">Just some colored text.</p>';
		expect(classifyEmailHtml(html)).toBe('simple');
	});
});

describe('remapInlineColorsForDark', () => {
	it('remaps dark text on transparent background to a readable color', () => {
		const html = '<p style="color:#222222">dark text</p>';
		const out = remapInlineColorsForDark(html);
		expect(out).not.toContain('#222222');
		const remapped = out.match(/color:(#[0-9a-f]{6})/i)?.[1];
		expect(remapped).toBeTruthy();
		expect(isReadableOnDark(parseCssColor(remapped!)!)).toBe(true);
	});

	it('leaves explicit white-on-blue button untouched', () => {
		const html = '<a style="color:#ffffff;background-color:#0a6cdd;padding:8px">Buy now</a>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('drops a white background and lightens the text it carried', () => {
		const html = '<span style="color:#111111;background:#ffffff">label</span>';
		expect(remapInlineColorsForDark(html)).toBe(
			`<span style="color:${POSTBOX_DARK_PALETTE.text}">label</span>`
		);
	});

	it('drops the white line background a pasted web.de body puts on every line', () => {
		// The text inherits the dark palette's light color; left in place, the
		// white fill made every line light-on-white.
		const html =
			'<div style="font-family:Verdana;font-size:12.0px"><div><span style="background-color:rgb(255, 255, 255)">first line</span></div>' +
			'<div><span style="background-color:rgb(255, 255, 255)">&nbsp;</span></div></div>';
		const out = remapInlineColorsForDark(html);
		expect(out).not.toContain('background');
		expect(out).toContain('<span>first line</span>');
		expect(out).toContain('font-family:Verdana;font-size:12.0px');
	});

	it('also drops near-white gray fills, but keeps a visible gray box', () => {
		expect(remapInlineColorsForDark('<p style="background-color:#f5f5f5">a</p>')).toBe('<p>a</p>');
		expect(remapInlineColorsForDark('<p style="background-color:#cccccc">a</p>')).toBe(
			'<p style="background-color:#cccccc;color:#1a1a1a">a</p>'
		);
	});

	it('lightens dark text nested inside a dropped white background', () => {
		const html =
			'<span style="background-color:#fff"><span style="color:#000000">nested</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			`<span><span style="color:${POSTBOX_DARK_PALETTE.text}">nested</span></span>`
		);
	});

	it('keeps white-on-white hidden text hidden', () => {
		const html = '<span style="color:#ffffff;background-color:#ffffff">hidden</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('gives a colored light highlight without its own text color dark text', () => {
		const html = '<span style="background-color:#ffff00">highlighted</span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span style="background-color:#ffff00;color:#1a1a1a">highlighted</span>'
		);
	});

	it('keeps colors inside a light highlight as written, and resumes after it', () => {
		const html =
			'<p style="background:#ffeb3b"><span style="color:#000000">on yellow</span><br></p>' +
			'<p style="color:#000000">after</p>';
		const out = remapInlineColorsForDark(html);
		expect(out).toContain('<span style="color:#000000">on yellow</span>');
		expect(out).toContain(`<p style="color:${POSTBOX_DARK_PALETTE.text}">after</p>`);
	});

	it('keeps a white background whose inherited text only hides on it', () => {
		const html = '<p style="color:#fff"><span style="background:#fff">hidden</span></p>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<p style="color:#fff"><span style="background:#fff;color:#fff">hidden</span></p>'
		);
	});

	it('keeps a white background behind near-transparent text', () => {
		const html = '<span style="background:#fff;color:rgba(0, 0, 0, 0.1)">faint</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('gives a light highlight the color its parent set, not the lightened one', () => {
		const html = '<p style="color:#333333"><span style="background-color:#ffff00">x</span></p>';
		expect(remapInlineColorsForDark(html)).toBe(
			`<p style="color:${POSTBOX_DARK_PALETTE.text}"><span style="background-color:#ffff00;color:#333333">x</span></p>`
		);
	});

	it('adapts text inside a dark fill nested in a light highlight', () => {
		const html =
			'<span style="background:#ffff00"><span style="background:#222222"><span style="color:#111111">deep</span></span></span>';
		expect(remapInlineColorsForDark(html)).toContain(
			`<span style="color:${POSTBOX_DARK_PALETTE.text}">deep</span>`
		);
	});

	it('only reads the real style attribute, not style= inside another value', () => {
		const html =
			'<a title=" style=\'background:#ff0\'"><span style="color:#000000">text</span></a>';
		expect(remapInlineColorsForDark(html)).toBe(
			`<a title=" style='background:#ff0'"><span style="color:${POSTBOX_DARK_PALETTE.text}">text</span></a>`
		);
	});

	it('lets an !important background win over a later white one', () => {
		const html =
			'<span style="background:#ff0!important;background-color:#fff;color:#111">x</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('lightens an !important text color and keeps it important', () => {
		expect(remapInlineColorsForDark('<p style="color:#000 !important">x</p>')).toBe(
			`<p style="color:${POSTBOX_DARK_PALETTE.text} !important">x</p>`
		);
	});

	it('keeps a white background under a background image', () => {
		const html =
			'<span style="background-color:#fff;background-image:url(https://example.com/a.png);color:#111">x</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('gives a nested white-on-white span back the white fill it hid on', () => {
		const html = '<span style="background:#fff"><span style="color:#fff">hidden</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span><span style="color:#fff;background-color:#ffffff">hidden</span></span>'
		);
	});

	it('keeps an inherited color it cannot parse on a kept light fill', () => {
		const html = '<p style="color:hsl(0,0%,100%)"><span style="background:#fff">hidden</span></p>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<p style="color:hsl(0,0%,100%)"><span style="background:#fff;color:hsl(0,0%,100%)">hidden</span></p>'
		);
	});

	it('treats color:inherit as no color of its own on a light fill', () => {
		expect(
			remapInlineColorsForDark('<span style="background:#ffff00;color:inherit">x</span>')
		).toBe('<span style="background:#ffff00;color:inherit;color:#1a1a1a">x</span>');
	});

	it('gives inherited text in a dark fill inside a highlight the palette text', () => {
		const html =
			'<span style="background:#ffff00"><span style="background:#222222">text</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			`<span style="background:#ffff00;color:#1a1a1a"><span style="background:#222222;color:${POSTBOX_DARK_PALETTE.text}">text</span></span>`
		);
	});

	it('keeps a white background under a shorthand background image', () => {
		const html =
			'<span style="background:url(https://example.com/a.png);background-color:#fff;color:#111">x</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('keeps encoded image URLs intact when it rewrites a style', () => {
		const html =
			'<span style="background:#ff0;background-image:url(https://example.com/a.png?a=1&amp;b=2)">x</span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span style="background:#ff0;background-image:url(https://example.com/a.png?a=1&amp;b=2);color:#1a1a1a">x</span>'
		);
	});

	it('does not split on a semicolon inside url()', () => {
		const html =
			'<p style="background-image:url(https://example.com/a.png?a=1;b=2);color:#000">x</p>';
		expect(remapInlineColorsForDark(html)).toBe(
			`<p style="background-image:url(https://example.com/a.png?a=1;b=2);color:${POSTBOX_DARK_PALETTE.text}">x</p>`
		);
	});

	it('treats color:unset as inheriting, so inherited hidden text keeps its fill', () => {
		const html =
			'<p style="color:#fff"><span style="background:#fff;color:unset">hidden</span></p>';
		expect(remapInlineColorsForDark(html)).toContain('background:#fff');
	});

	it('gives a nested span the white fill back when its hsl() text hid on it', () => {
		const html =
			'<span style="background:#fff"><span style="color:hsl(0,0%,100%)">hidden</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span><span style="color:hsl(0,0%,100%);background-color:#ffffff">hidden</span></span>'
		);
	});

	it('makes a restored fill win over an !important transparent background', () => {
		const html =
			'<span style="background:#fff"><span style="background:transparent!important;color:#fff">hidden</span></span>';
		expect(remapInlineColorsForDark(html)).toContain(
			'<span style="background:transparent!important;color:#fff;background-color:#ffffff !important">'
		);
	});

	it('makes the added highlight text color win over color:inherit!important', () => {
		expect(
			remapInlineColorsForDark('<span style="background:#ffff00;color:inherit!important">x</span>')
		).toBe(
			'<span style="background:#ffff00;color:inherit!important;color:#1a1a1a !important">x</span>'
		);
	});

	it('drops a white fill written as a full background shorthand', () => {
		const html = '<span style="background:rgb(255, 255, 255) none repeat scroll 0% 0%">line</span>';
		expect(remapInlineColorsForDark(html)).toBe('<span>line</span>');
	});

	it('reads the color of a shorthand that carries no image', () => {
		const html = '<span style="background:#ffff00 none repeat scroll 0% 0%">x</span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span style="background:#ffff00 none repeat scroll 0% 0%;color:#1a1a1a">x</span>'
		);
	});

	it('lightens dark hsl() and space-separated rgb() text', () => {
		expect(remapInlineColorsForDark('<p style="color:hsl(0, 0%, 10%)">x</p>')).toBe(
			`<p style="color:${POSTBOX_DARK_PALETTE.text}">x</p>`
		);
		expect(remapInlineColorsForDark('<p style="color:rgb(0 0 0 / 100%)">x</p>')).toBe(
			`<p style="color:${POSTBOX_DARK_PALETTE.text}">x</p>`
		);
	});

	it('restores the dropped fill under a translucent child fill that hid text', () => {
		const html =
			'<span style="background:#fff"><span style="background:rgba(255,255,255,0.1);color:#fff">hidden</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span><span style="background:rgba(255,255,255,0.1);color:#fff;background-color:#ffffff">hidden</span></span>'
		);
	});

	it('restores the dropped fill under a colorless shorthand that hid text', () => {
		const html =
			'<span style="background:#fff"><span style="background:none repeat scroll 0% 0%;color:#fff">hidden</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span><span style="background:none repeat scroll 0% 0%;color:#fff;background-color:#ffffff">hidden</span></span>'
		);
	});

	it('drops a white shorthand fill with an unspaced position/size', () => {
		expect(remapInlineColorsForDark('<span style="background:#fff 0 0/auto">text</span>')).toBe(
			'<span>text</span>'
		);
	});

	it('restores the dropped fill behind a background reset to initial', () => {
		for (const style of ['background:initial', 'background-color:unset']) {
			const html = `<span style="background:#fff"><span style="${style};color:#fff">hidden</span></span>`;
			expect(remapInlineColorsForDark(html)).toContain('background-color:#ffffff">hidden');
		}
	});

	it('keeps hidden text hidden through a translucent wrapper', () => {
		const html =
			'<span style="background:#fff"><span style="background:rgba(255,255,255,0.1)"><span style="color:#fff">hidden</span></span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span><span><span style="color:#fff;background-color:#ffffff">hidden</span></span></span>'
		);
	});

	it('resolves a translucent tint over a dropped fill to the gray it showed', () => {
		// rgba(0,0,0,0.3) over white is #b3b3b3; the matching text stays hidden on it.
		const html =
			'<span style="background:#fff"><span style="background:rgba(0,0,0,0.3);color:#b3b3b3">hidden</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(
			'<span><span style="background:rgba(0,0,0,0.3);color:#b3b3b3;background-color:#b3b3b3">hidden</span></span>'
		);
	});

	it('keeps a white chip inside a colored fill', () => {
		const html =
			'<span style="background:#008000;color:#fff"><span style="background:#fff;color:#008000">Approved</span></span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('restores the dropped fill behind background:inherit', () => {
		for (const style of ['background:inherit', 'background-color:inherit']) {
			const html = `<span style="background:#fff"><span style="${style};color:#fff">hidden</span></span>`;
			expect(remapInlineColorsForDark(html)).toContain('background-color:#ffffff">hidden');
		}
	});

	it('ignores a background image the shorthand overrides', () => {
		const html =
			'<span style="background-image:url(https://example.com/old.png);background:#fff">line</span>';
		expect(remapInlineColorsForDark(html)).toBe('<span>line</span>');
	});

	it('stays linear on deeply nested markup', () => {
		// Quadratic stack handling took seconds at this depth; linear is ~0.2 s.
		const depth = 40_000;
		const html = `${'<span style="color:#000">'.repeat(depth)}x${'</span>'.repeat(depth)}`;
		const startedAt = performance.now();
		remapInlineColorsForDark(html);
		expect(performance.now() - startedAt).toBeLessThan(2000);
	});

	it('leaves a translucent tint that stays dark on the dark page alone', () => {
		const html = '<span style="background-color:rgba(255, 235, 59, 0.15)">tint</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('keeps readable colored text as-is', () => {
		const html = '<p style="color:#ff8888">warm text</p>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('keeps a quoted font-family intact when it remaps the color', () => {
		// sanitize-html writes font-name quotes as &quot; — the `;` inside the
		// entity must not split the declaration (it used to drop the font and
		// fall back to the default serif).
		const html =
			'<span style="font-size:10.0pt;font-family:&quot;Arial&quot;,sans-serif;color:black">sig</span>';
		const out = remapInlineColorsForDark(html);
		expect(out).toContain('font-family:&quot;Arial&quot;,sans-serif');
		expect(out).toContain('font-size:10.0pt');
		expect(out).not.toContain('color:black');
	});

	it('does not touch unparseable color values', () => {
		const html = '<p style="color:currentColor">meh</p>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});
});

describe('adaptEmailHtml', () => {
	const simple = '<p style="color:#1a1a1a">hello</p>';
	const designed = '<table bgcolor="#f0f0f0"><tr><td>promo</td></tr></table>';

	it('light app scheme is a zero-change pass-through', () => {
		expect(adaptEmailHtml(simple, 'light')).toEqual({
			html: simple,
			scheme: 'light',
			kind: 'simple',
		});
		expect(adaptEmailHtml(designed, 'light').html).toBe(designed);
	});

	it('classifies designed mail on the light path too (HTML untouched)', () => {
		expect(adaptEmailHtml(designed, 'light')).toEqual({
			html: designed,
			scheme: 'light',
			kind: 'designed',
		});
	});

	it('dark app + simple mail renders dark with remapped colors', () => {
		const out = adaptEmailHtml(simple, 'dark');
		expect(out.scheme).toBe('dark');
		expect(out.kind).toBe('simple');
		expect(out.html).not.toContain('#1a1a1a');
	});

	it('dark app + designed mail keeps its own colors on a light scheme', () => {
		const out = adaptEmailHtml(designed, 'dark');
		expect(out.scheme).toBe('light');
		expect(out.kind).toBe('designed');
		expect(out.html).toBe(designed);
	});
});

describe('buildBaseStyle', () => {
	it('light output sets the base typography, image cap and link color', () => {
		const style = buildBaseStyle('light');
		expect(style).toContain('color:#1a1a1a');
		expect(style).toContain('font-size:14px');
		expect(style).toContain('img{max-width:100%;height:auto;}');
		expect(style).toContain('a{color:#0a6cdd;}');
	});

	it("restores Outlook's paragraph reset in both schemes and kinds", () => {
		for (const scheme of ['light', 'dark'] as const) {
			for (const kind of ['simple', 'designed'] as const) {
				expect(buildBaseStyle(scheme, kind)).toContain(
					'p.MsoNormal,li.MsoNormal,div.MsoNormal{margin:0;'
				);
			}
		}
	});

	it('dark output sets color-scheme, dark background, light text and link color', () => {
		const style = buildBaseStyle('dark');
		expect(style).toContain('color-scheme:dark');
		expect(style).toContain(`background:${POSTBOX_DARK_PALETTE.background}`);
		expect(style).toContain(`color:${POSTBOX_DARK_PALETTE.text}`);
		expect(style).toContain(`a{color:${POSTBOX_DARK_PALETTE.link}`);
	});

	it('simple mail gets a left-aligned reading measure on a transparent canvas', () => {
		for (const scheme of ['light', 'dark'] as const) {
			const style = buildBaseStyle(scheme, 'simple');
			expect(style).toContain('max-width:72ch');
			// Aligned with the message header, not floated to the middle.
			expect(style).not.toContain('margin:0 auto');
			expect(style).toContain('line-height:1.6;');
			expect(style).toContain('font-size:15px');
			expect(style).toContain('html,body{background:transparent;}');
		}
	});

	it('simple mail wraps <pre> (the sanitizer strips the inline white-space of a text body)', () => {
		for (const scheme of ['light', 'dark'] as const) {
			expect(buildBaseStyle(scheme, 'simple')).toContain('pre{white-space:pre-wrap;}');
		}
	});

	it('designed mail keeps its own canvas (no measure cap, no transparency)', () => {
		expect(buildBaseStyle('light', 'designed')).toBe(buildBaseStyle('light'));
		expect(buildBaseStyle('dark', 'designed')).toBe(buildBaseStyle('dark'));
		for (const scheme of ['light', 'dark'] as const) {
			const style = buildBaseStyle(scheme, 'designed');
			expect(style).not.toContain('72ch');
			expect(style).not.toContain('background:transparent');
		}
	});
});
