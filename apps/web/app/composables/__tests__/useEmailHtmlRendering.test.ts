import { describe, expect, it } from 'vitest';
import { useEmailHtmlRendering } from '../useEmailHtmlRendering';

const textBlock = { id: 'a', type: 'text', content: { html: '<p>Saved block body</p>' } };

describe('useEmailHtmlRendering renderContentToHtml', () => {
	const { renderContentToHtml } = useEmailHtmlRendering();
	const render = (content: string) =>
		renderContentToHtml(content, { variableType: 'personalization' });

	it('renders a bare block array', () => {
		expect(render(JSON.stringify([textBlock]))).toContain('Saved block body');
	});

	// Regression: the private reader this composable used to carry only knew the
	// bare array, so a saved block's { blocks } envelope rendered an empty email.
	it('renders the { blocks } envelope a saved block is stored in', () => {
		expect(render(JSON.stringify({ blocks: [textBlock] }))).toContain('Saved block body');
	});

	it('renders an empty email for unreadable content instead of throwing', () => {
		expect(render('not json')).not.toContain('Saved block body');
	});
});
