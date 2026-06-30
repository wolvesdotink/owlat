import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Per-Client Render Preview Simulation', () => {
	const blocks: EditorBlock[] = [
		{
			id: '1',
			type: 'text',
			content: {
				html: '<p>Hello world</p>',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#333',
			},
		},
	];

	it('gmail simulation strips <style> block', () => {
		const html = renderEmailHtml(blocks, { targetClient: 'gmail' });
		expect(html).not.toContain('<style>');
	});

	it('gmail simulation strips class attributes', () => {
		const html = renderEmailHtml(blocks, { targetClient: 'gmail' });
		expect(html).not.toMatch(/ class="[^"]+"/);
	});

	it('outlookDesktop simulation strips border-radius', () => {
		const blocksWithRadius: EditorBlock[] = [
			{
				id: '1',
				type: 'button',
				content: {
					text: 'Click',
					url: 'https://example.com',
					backgroundColor: '#000',
					textColor: '#fff',
					align: 'center',
					borderRadius: 8,
					paddingX: 24,
					paddingY: 12,
				},
			},
		];
		const html = renderEmailHtml(blocksWithRadius, { targetClient: 'outlookDesktop' });
		expect(html).not.toContain('border-radius');
	});

	it('outlookDesktop simulation strips media queries', () => {
		const html = renderEmailHtml(blocks, { targetClient: 'outlookDesktop' });
		expect(html).not.toContain('@media');
	});

	it('appleMail simulation returns full HTML unchanged (gold standard)', () => {
		const htmlNormal = renderEmailHtml(blocks);
		const htmlApple = renderEmailHtml(blocks, { targetClient: 'appleMail' });
		expect(htmlApple).toBe(htmlNormal);
	});

	it('outlookNew simulation keeps most CSS intact', () => {
		const html = renderEmailHtml(blocks, { targetClient: 'outlookNew' });
		// New Outlook supports <style> blocks
		expect(html).toContain('<style>');
	});

	it('yahooMail simulation strips position:absolute', () => {
		const html = renderEmailHtml(blocks, { targetClient: 'yahooMail' });
		expect(html).not.toContain('position:absolute');
		expect(html).not.toContain('position: absolute');
	});
});
