import { describe, expect, it } from 'vitest';
import { forceColorScheme, renderEmailHtml } from '../index';

const html = renderEmailHtml([
	{
		id: 'b-text',
		type: 'text',
		content: { html: '<p>Hello</p>', blockType: 'paragraph', fontSize: 14, textColor: '#374151' },
	},
] as Parameters<typeof renderEmailHtml>[0]);

describe('forceColorScheme', () => {
	it('applies the email’s own dark rules for dark, and drops them for light', () => {
		expect(html).toContain('@media (prefers-color-scheme:dark){');
		const dark = forceColorScheme(html, 'dark');
		expect(dark).toContain('@media all{');
		expect(dark).not.toContain('prefers-color-scheme');
		const light = forceColorScheme(html, 'light');
		expect(light).toContain('@media not all{');
		expect(light).not.toContain('prefers-color-scheme');
	});

	it('changes nothing else', () => {
		expect(forceColorScheme(html, 'dark').replace('@media all{', '')).toBe(
			html.replace('@media (prefers-color-scheme:dark){', '')
		);
	});
});
