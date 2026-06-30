import { describe, it, expect } from 'vitest';
import { inlineCss } from '../inliner';

describe('CSS Inliner', () => {
	it('should inline simple class styles onto elements', () => {
		const html = '<style>.foo{color:red;font-size:16px}</style><div class="foo">Hello</div>';
		const result = inlineCss(html);
		expect(result).toContain('style="color:red;font-size:16px"');
	});

	it('should inline element selector styles', () => {
		const html = '<style>p{color:blue}</style><p>Hello</p>';
		const result = inlineCss(html);
		expect(result).toContain('style="color:blue"');
	});

	it('should preserve existing inline styles (higher priority)', () => {
		const html = '<style>.foo{color:red;font-size:16px}</style><div class="foo" style="color:blue">Hello</div>';
		const result = inlineCss(html);
		// Existing color:blue should override, but font-size:16px should be added
		expect(result).toContain('font-size:16px');
		expect(result).toContain('color:blue');
	});

	it('should not inline styles from @media blocks', () => {
		const html = '<style>@media(max-width:480px){.foo{color:red}}</style><div class="foo">Hello</div>';
		const result = inlineCss(html);
		// Should NOT inline the media query rule
		expect(result).not.toContain('style="color:red"');
	});

	it('should not inline pseudo-selector rules', () => {
		const html = '<style>a:hover{color:red}</style><a href="#">Hello</a>';
		const result = inlineCss(html);
		// The <a> tag should NOT get an inline style from a:hover rule
		expect(result).toContain('<a href="#"');
		expect(result).not.toContain('<a href="#" style=');
	});

	it('should skip animation properties', () => {
		const html = '<style>.animated{animation:fadeIn 1s;color:red}</style><div class="animated">Hello</div>';
		const result = inlineCss(html);
		// color:red should be inlined, but animation should not be in the inline style
		const inlineStyle = result.match(/style="([^"]*)"/)?.[1] || '';
		expect(inlineStyle).toContain('color:red');
		expect(inlineStyle).not.toContain('animation');
	});

	it('should handle html with no style tag', () => {
		const html = '<div class="foo">Hello</div>';
		const result = inlineCss(html);
		expect(result).toBe(html);
	});

	it('should handle multiple matching rules', () => {
		const html = '<style>td{color:red} .highlight{font-weight:bold}</style><td class="highlight">Hello</td>';
		const result = inlineCss(html);
		expect(result).toContain('color:red');
		expect(result).toContain('font-weight:bold');
	});

	it('should preserve the <style> block (for media queries etc.)', () => {
		const html = '<style>.foo{color:red}@media(max-width:480px){.bar{color:blue}}</style><div class="foo">Hello</div>';
		const result = inlineCss(html);
		expect(result).toContain('<style>');
		expect(result).toContain('@media');
	});
});
