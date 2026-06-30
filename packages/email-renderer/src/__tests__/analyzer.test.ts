import { describe, it, expect } from 'vitest';
import { analyzeEmail } from '../analyzer';

describe('analyzeEmail', () => {
	const minimalHtml = '<html><body><p>Hello world, this is a test email with enough text content to pass the threshold check for having text content in the analysis.</p></body></html>';

	it('returns linkCount, hasTextContent, textToImageRatio, displayNoneCount', () => {
		const result = analyzeEmail(minimalHtml);
		expect(result).toHaveProperty('linkCount');
		expect(result).toHaveProperty('hasTextContent');
		expect(result).toHaveProperty('textToImageRatio');
		expect(result).toHaveProperty('displayNoneCount');
	});

	it('counts <a tags correctly', () => {
		const html = '<html><body><a href="https://a.com">A</a> text <a href="https://b.com">B</a> more <a href="https://c.com">C</a></body></html>';
		const result = analyzeEmail(html);
		expect(result.linkCount).toBe(3);
	});

	it('hasTextContent is true for text-heavy HTML', () => {
		const result = analyzeEmail(minimalHtml);
		expect(result.hasTextContent).toBe(true);
	});

	it('hasTextContent is false for image-only HTML', () => {
		const html = '<html><body><img src="a.jpg" /><img src="b.jpg" /></body></html>';
		const result = analyzeEmail(html);
		expect(result.hasTextContent).toBe(false);
	});

	it('calculates textToImageRatio correctly', () => {
		const html = '<html><body><p>Some reasonable text content here</p><img src="a.jpg" /></body></html>';
		const result = analyzeEmail(html);
		expect(result.textToImageRatio).toBeGreaterThan(0);
		expect(result.imageCount).toBe(1);
	});

	it('displayNoneCount subtracts 2 for preheader divs', () => {
		// 2 display:none from preheader + 1 extra
		const html = '<html><body><div style="display:none">preheader</div><div style="display:none">padding</div><div style="display:none">hidden</div></body></html>';
		const result = analyzeEmail(html);
		expect(result.displayNoneCount).toBe(1);
	});

	it('displayNoneCount is 0 when only preheader display:none exists', () => {
		const html = '<html><body><div style="display:none">preheader</div><div style="display:none">padding</div><p>content</p></body></html>';
		const result = analyzeEmail(html);
		expect(result.displayNoneCount).toBe(0);
	});

	it('warns when link count exceeds 60', () => {
		const links = Array.from({ length: 61 }, (_, i) => `<a href="https://example.com/${i}">Link ${i}</a>`).join('');
		const html = `<html><body>${links}</body></html>`;
		const result = analyzeEmail(html);
		expect(result.warnings.some((w) => w.includes('link count'))).toBe(true);
	});

	it('warns for image-only email', () => {
		const html = '<html><body><img src="a.jpg" /><img src="b.jpg" /></body></html>';
		const result = analyzeEmail(html);
		expect(result.warnings.some((w) => w.includes('image-only'))).toBe(true);
	});

	it('warns for low text-to-image ratio', () => {
		const html = '<html><body><p>Hi</p><img src="a.jpg" /><img src="b.jpg" /><img src="c.jpg" /></body></html>';
		const result = analyzeEmail(html);
		expect(result.warnings.some((w) => w.includes('text-to-image ratio'))).toBe(true);
	});

	it('warns when subject line exceeds 70 chars', () => {
		const result = analyzeEmail(minimalHtml, { subjectLine: 'A'.repeat(71) });
		expect(result.warnings.some((w) => w.includes('Subject line'))).toBe(true);
	});

	it('warns for ALL CAPS subject line', () => {
		const result = analyzeEmail(minimalHtml, { subjectLine: 'BUY NOW FREE SALE' });
		expect(result.warnings.some((w) => w.includes('ALL CAPS'))).toBe(true);
	});

	it('does not warn for normal subject line', () => {
		const result = analyzeEmail(minimalHtml, { subjectLine: 'Your weekly update' });
		expect(result.warnings.some((w) => w.includes('Subject line'))).toBe(false);
		expect(result.warnings.some((w) => w.includes('ALL CAPS'))).toBe(false);
	});
});
