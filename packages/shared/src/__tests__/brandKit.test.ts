import { describe, expect, it } from 'vitest';
import {
	BRAND_FONTS,
	DEFAULT_BRAND_KIT_DESIGN,
	brandKitDesignProblem,
	brandKitEmailTheme,
	brandSwatches,
	brandWebFontUrls,
	readableTextColor,
	resolveBrandKitDesign,
	type BrandKitDesign,
} from '../brandKit';
import { DEFAULT_EMAIL_THEME } from '../emailDefaults';

const configured = (overrides: Partial<BrandKitDesign> = {}): BrandKitDesign => ({
	...DEFAULT_BRAND_KIT_DESIGN,
	isConfigured: true,
	...overrides,
});

describe('resolveBrandKitDesign', () => {
	it('is the defaults, unconfigured, when nothing is stored', () => {
		expect(resolveBrandKitDesign(undefined, undefined)).toEqual(DEFAULT_BRAND_KIT_DESIGN);
	});

	it('takes the four theme values from the email theme column', () => {
		const design = resolveBrandKitDesign(
			{
				primaryColor: '#0f766e',
				fontFamily: 'Georgia, serif',
				backgroundColor: '',
				baseWidth: 640,
			},
			undefined
		);
		expect(design).toMatchObject({
			isConfigured: false,
			primaryColor: '#0f766e',
			bodyFontFamily: 'Georgia, serif',
			backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
			baseWidth: 640,
		});
	});

	it('is configured once the brand kit column exists, and headings default to the body font', () => {
		const design = resolveBrandKitDesign(
			{ primaryColor: '#0f766e', fontFamily: 'Georgia, serif', backgroundColor: '#ffffff' },
			{ textColor: '#111827' }
		);
		expect(design.isConfigured).toBe(true);
		expect(design.textColor).toBe('#111827');
		expect(design.headingFontFamily).toBe('Georgia, serif');
		expect(design.buttonRadius).toBe(8);
	});
});

describe('brandKitEmailTheme', () => {
	it('is exactly the four-key theme until a kit is saved', () => {
		const theme = brandKitEmailTheme(
			resolveBrandKitDesign(
				{ primaryColor: '#123456', fontFamily: 'Arial, sans-serif', backgroundColor: '#fafafa' },
				undefined
			)
		);
		expect(theme).toEqual({
			primaryColor: '#123456',
			fontFamily: 'Arial, sans-serif',
			backgroundColor: '#fafafa',
			baseWidth: 600,
		});
	});

	it('carries text, link, heading font, web fonts and block styles once configured', () => {
		const theme = brandKitEmailTheme(
			configured({
				primaryColor: '#0f766e',
				textColor: '#1f2937',
				linkColor: '#0369a1',
				secondaryColor: '#94a3b8',
				headingFontFamily: "'Playfair Display', Georgia, serif",
				bodyFontFamily: "'Inter', Arial, sans-serif",
				buttonRadius: 20,
			})
		);
		expect(theme).toMatchObject({
			bodyTextColor: '#1f2937',
			linkColor: '#0369a1',
			headingFontFamily: "'Playfair Display', Georgia, serif",
		});
		expect(theme.fontUrls).toHaveLength(2);
		expect(theme.blockDefaults?.button).toEqual({
			backgroundColor: '#0f766e',
			textColor: '#ffffff',
			borderRadius: 20,
			paddingX: 24,
			paddingY: 12,
		});
		expect(theme.blockDefaults?.divider).toEqual({ color: '#94a3b8' });
		expect(theme.blockDefaults?.text).toEqual({ textColor: '#1f2937' });
	});

	it('links no stylesheet for email-safe fonts', () => {
		expect(brandKitEmailTheme(configured()).fontUrls).toBeUndefined();
	});
});

describe('brandWebFontUrls', () => {
	it('returns one Google Fonts URL per web font and none for safe fonts', () => {
		const inter = BRAND_FONTS.find((f) => f.id === 'inter')!.stack;
		expect(brandWebFontUrls(inter, inter, 'Arial, sans-serif')).toEqual([
			'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
		]);
	});

	it('every web font falls back to an email-safe font', () => {
		for (const font of BRAND_FONTS.filter((f) => f.webFontUrl)) {
			expect(font.stack).toMatch(/, (Arial|Georgia), (sans-serif|serif)$/);
		}
	});
});

describe('readableTextColor', () => {
	it('picks white on dark and near-black on light', () => {
		expect(readableTextColor('#0f172a')).toBe('#ffffff');
		expect(readableTextColor('#fde68a')).toBe('#12110e');
		expect(readableTextColor('#fff')).toBe('#12110e');
	});

	it('falls back to white for something that is not a hex colour', () => {
		expect(readableTextColor('rgb(0,0,0)')).toBe('#ffffff');
	});
});

describe('brandSwatches', () => {
	it('lists the named colours then the extra swatches, lower-cased and without duplicates', () => {
		expect(
			brandSwatches(
				configured({
					primaryColor: '#0F766E',
					linkColor: '#0f766e',
					swatches: ['#FACC15', '#ffffff'],
				})
			)
		).toEqual(['#0f766e', '#282d3a', '#374151', '#ffffff', '#facc15']);
	});
});

describe('brandKitDesignProblem', () => {
	const valid = configured();

	it('accepts the defaults', () => {
		expect(brandKitDesignProblem(valid)).toBeNull();
	});

	it.each([
		[{ primaryColor: 'red' }, 'invalidColor'],
		[{ swatches: ['#1234'] }, 'invalidColor'],
		[{ swatches: Array.from({ length: 7 }, () => '#000000') }, 'tooManySwatches'],
		[{ bodyFontFamily: 'Comic Sans MS' }, 'unknownFont'],
		[{ buttonRadius: 41 }, 'buttonOutOfRange'],
		[{ buttonPaddingY: Number.NaN }, 'buttonOutOfRange'],
		[{ baseWidth: 900 }, 'widthOutOfRange'],
		[{ footerCompanyName: 'x'.repeat(121) }, 'companyNameTooLong'],
		[{ footerAddress: 'x'.repeat(301) }, 'addressTooLong'],
		[
			{ footerSocialLinks: [{ platform: 'github' as const, url: 'javascript:alert(1)' }] },
			'invalidSocialUrl',
		],
	])('refuses %o as %s', (patch, problem) => {
		expect(brandKitDesignProblem({ ...valid, ...patch })).toBe(problem);
	});
});
