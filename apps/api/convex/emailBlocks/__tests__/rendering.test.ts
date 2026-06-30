/**
 * Unit tests for the saved-block rerender row renderer.
 *
 * `rerenderRow` is the shared per-consumer-row body of the
 * `reRenderEmails` action. The action loads the org's `instanceSettings`
 * email theme once and threads it through here so propagated saved-block
 * HTML keeps the same brand styling the editor save path applies. Without
 * the theme the renderer falls back to its `DEFAULT_THEME`
 * (primaryColor #c4785a, Arial, #ffffff, baseWidth 600) and silently
 * reverts the org's brand colors on every template/transactional email.
 *
 * These tests pin the theme down to the rendered HTML so the two render
 * paths can't drift apart again.
 */

import { describe, it, expect } from 'vitest';
import { rerenderRow } from '../rendering';

const buttonContent = JSON.stringify([
	{
		id: 'b1',
		type: 'button',
		content: {
			text: 'Go',
			url: 'https://example.com',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 8,
		},
	},
]);

const baseRow = {
	content: buttonContent,
	subject: 'Hello',
};

describe('rerenderRow theme propagation', () => {
	it('applies the org email theme background + base width to the rendered HTML', () => {
		const { html } = rerenderRow(baseRow, 'personalization', {
			primaryColor: '#0044ff',
			fontFamily: 'Georgia, serif',
			backgroundColor: '#102030',
			baseWidth: 720,
		});

		// Body background comes straight from theme.backgroundColor.
		expect(html).toContain('background-color:#102030');
		// Base width comes straight from theme.baseWidth.
		expect(html).toContain('max-width:720px');
		// The renderer DEFAULT_THEME background must NOT leak through.
		expect(html).not.toContain('background-color:#ffffff');
	});

	it('falls back to the renderer default theme when no theme is passed', () => {
		const { html } = rerenderRow(baseRow, 'personalization', undefined);

		// DEFAULT_THEME: white background, 600px base width.
		expect(html).toContain('background-color:#ffffff');
		expect(html).toContain('max-width:600px');
	});

	it('applies the theme to per-language translation HTML too', () => {
		const { htmlTranslations } = rerenderRow(
			{
				...baseRow,
				defaultLanguage: 'en',
				supportedLanguages: ['en', 'de'],
				translations: JSON.stringify({
					de: {
						subject: 'Hallo',
						blocks: { b1: { buttonText: 'Los' } },
					},
				}),
			},
			'personalization',
			{
				primaryColor: '#0044ff',
				fontFamily: 'Georgia, serif',
				backgroundColor: '#102030',
				baseWidth: 720,
			},
		);

		expect(htmlTranslations).toBeDefined();
		const parsed = JSON.parse(htmlTranslations as string) as Record<
			string,
			{ htmlContent: string; subject: string }
		>;
		const de = parsed['de'];
		expect(de).toBeDefined();
		// The translated render must carry the org theme, not DEFAULT_THEME.
		expect(de!.htmlContent).toContain('background-color:#102030');
		expect(de!.htmlContent).toContain('max-width:720px');
		// Translated text was overlaid.
		expect(de!.htmlContent).toContain('Los');
		expect(de!.subject).toBe('Hallo');
	});
});
