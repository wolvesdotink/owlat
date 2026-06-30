import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../../../renderer';
import type { EditorBlock, ProgressBarBlockContent } from '@owlat/shared';

describe('ProgressBar Block', () => {
	const makeProgressBlock = (content: Partial<ProgressBarBlockContent>): EditorBlock => ({
		id: 'progress-1',
		type: 'progressBar',
		content: {
			value: 75,
			barColor: '#4CAF50',
			trackColor: '#e0e0e0',
			height: 20,
			...content,
		} as ProgressBarBlockContent,
	});

	it('should render progress bar with correct percentage width', () => {
		const html = renderEmailHtml([makeProgressBlock({})], { inlineCss: false });
		expect(html).toContain('width:75%');
	});

	it('should render with custom colors', () => {
		const html = renderEmailHtml([makeProgressBlock({
			barColor: '#ff0000',
			trackColor: '#cccccc',
		})], { inlineCss: false });
		expect(html).toContain('background-color:#ff0000');
		expect(html).toContain('background-color:#cccccc');
	});

	it('should render label on the right', () => {
		const html = renderEmailHtml([makeProgressBlock({
			showLabel: true,
			labelPosition: 'right',
		})], { inlineCss: false });
		expect(html).toContain('75%');
	});

	it('should render label inside the bar', () => {
		const html = renderEmailHtml([makeProgressBlock({
			showLabel: true,
			labelPosition: 'inside',
		})], { inlineCss: false });
		expect(html).toContain('75%');
	});

	it('should clamp value to 0-100 range', () => {
		const html = renderEmailHtml([makeProgressBlock({ value: 150 })], { inlineCss: false });
		expect(html).toContain('width:100%');
	});

	it('should handle zero progress', () => {
		const html = renderEmailHtml([makeProgressBlock({ value: 0 })], { inlineCss: false });
		// At 0%, only the track cell is rendered (no bar cell)
		expect(html).toContain('background-color:#e0e0e0');
		expect(html).not.toContain('background-color:#4CAF50');
	});

	it('should apply border radius', () => {
		const html = renderEmailHtml([makeProgressBlock({ borderRadius: 10 })], { inlineCss: false });
		expect(html).toContain('border-radius:10px');
	});

	it('should use custom maxValue', () => {
		const html = renderEmailHtml([makeProgressBlock({ value: 50, maxValue: 200 })], { inlineCss: false });
		expect(html).toContain('width:25%');
	});
});
