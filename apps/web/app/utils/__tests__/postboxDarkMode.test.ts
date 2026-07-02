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
		expect(
			contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })
		).toBeCloseTo(21, 1);
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
});

describe('classifyEmailHtml', () => {
	it('plain paragraphs classify as simple', () => {
		const html = '<p>Hi there,</p><p>See you <b>tomorrow</b> at 10.</p><p>Best,<br>Ana</p>';
		expect(classifyEmailHtml(html)).toBe('simple');
	});

	it('bgcolor table mail classifies as designed', () => {
		const html =
			'<table bgcolor="#ffffff" width="600"><tr><td>Big sale!</td></tr></table>';
		expect(classifyEmailHtml(html)).toBe('designed');
	});

	it('explicit non-transparent background on a container classifies as designed', () => {
		const html = '<div style="background-color:#f4f4f4;padding:20px">Newsletter</div>';
		expect(classifyEmailHtml(html)).toBe('designed');
	});

	it('background-image on a container classifies as designed', () => {
		const html =
			`<td style="background-image:url('https://x.test/hero.png')">Hero</td>`;
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
		const html =
			'<a style="color:#ffffff;background-color:#0a6cdd;padding:8px">Buy now</a>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('leaves dark text untouched when the element sets its own light background', () => {
		const html = '<span style="color:#111111;background:#ffffff">label</span>';
		expect(remapInlineColorsForDark(html)).toBe(html);
	});

	it('keeps readable colored text as-is', () => {
		const html = '<p style="color:#ff8888">warm text</p>';
		expect(remapInlineColorsForDark(html)).toBe(html);
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
	it('light output is byte-identical to the historical BASE_STYLE', () => {
		expect(buildBaseStyle('light')).toBe(
			`<style>html,body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.55;margin:0;padding:0;}img{max-width:100%;height:auto;}a{color:#0a6cdd;}</style>`
		);
	});

	it('dark output sets color-scheme, dark background, light text and link color', () => {
		const style = buildBaseStyle('dark');
		expect(style).toContain('color-scheme:dark');
		expect(style).toContain(`background:${POSTBOX_DARK_PALETTE.background}`);
		expect(style).toContain(`color:${POSTBOX_DARK_PALETTE.text}`);
		expect(style).toContain(`a{color:${POSTBOX_DARK_PALETTE.link}`);
	});

	it('simple mail gets the comfortable reading measure in both schemes', () => {
		for (const scheme of ['light', 'dark'] as const) {
			const style = buildBaseStyle(scheme, 'simple');
			expect(style).toContain('max-width:70ch');
			expect(style).toContain('margin:0 auto');
			expect(style).toContain('line-height:1.6;');
			expect(style).toContain('font-size:15px');
		}
	});

	it('designed mail keeps the historical base style (no measure cap)', () => {
		expect(buildBaseStyle('light', 'designed')).toBe(buildBaseStyle('light'));
		expect(buildBaseStyle('dark', 'designed')).toBe(buildBaseStyle('dark'));
		expect(buildBaseStyle('light', 'designed')).not.toContain('70ch');
		expect(buildBaseStyle('dark', 'designed')).not.toContain('70ch');
	});
});
