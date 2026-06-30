import { describe, it, expect } from 'vitest';
import { renderMenuContent } from '../index';
import type { MenuBlockContent } from '@owlat/shared';
import type { RenderContext } from '../../../types';

const createCtx = (overrides?: Partial<RenderContext>): RenderContext => ({
	theme: { primaryColor: '#c4785a', fontFamily: 'Arial, sans-serif', backgroundColor: '#ffffff' },
	darkMode: false,
	variableType: 'personalization',
	variableClass: 'personalization-variable',
	baseWidth: 600,
	preheaderText: '',
	title: '',
	breakpoint: 480,
	direction: 'ltr',
	fontUrls: [],
	customCss: '',
	variableValues: {},
	lang: 'en',
	responsiveRules: [],
	globalRules: [],
	warnings: [],
	...overrides,
});

const makeContent = (overrides?: Partial<MenuBlockContent>): MenuBlockContent => ({
	items: [
		{ label: 'Home', url: 'https://example.com' },
		{ label: 'About', url: 'https://example.com/about' },
		{ label: 'Contact', url: 'https://example.com/contact' },
	],
	align: 'center',
	...overrides,
});

describe('renderMenuContent', () => {
	it('renders horizontal links with hrefs and labels', () => {
		const html = renderMenuContent(makeContent(), createCtx());
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('Home');
		expect(html).toContain('href="https://example.com/about"');
		expect(html).toContain('About');
		expect(html).toContain('Contact');
	});

	it('renders separator characters between items', () => {
		const html = renderMenuContent(makeContent({ separator: '|' }), createCtx());
		expect(html).toContain('|');
	});

	it('returns empty string for no items', () => {
		const html = renderMenuContent(makeContent({ items: [] }), createCtx());
		expect(html).toBe('');
	});

	it('renders plain table without hamburger markup when hamburgerOnMobile is false', () => {
		const html = renderMenuContent(makeContent({ hamburgerOnMobile: false }), createCtx());
		expect(html).toContain('<table');
		expect(html).not.toContain('owlat-desktop-nav');
		expect(html).not.toContain('owlat-hamburger');
		expect(html).not.toContain('owlat-mobile-nav');
	});

	it('renders hamburger markup when hamburgerOnMobile is true', () => {
		const html = renderMenuContent(makeContent({ hamburgerOnMobile: true }), createCtx());
		expect(html).toContain('owlat-desktop-nav');
		expect(html).toContain('owlat-hamburger');
		expect(html).toContain('owlat-mobile-nav');
		expect(html).toContain('owlat-menu-toggle');
		expect(html).toContain('<style>');
		// Mobile links are rendered vertically
		expect(html).toContain('display:block');
	});
});
