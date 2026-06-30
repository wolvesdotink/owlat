import { describe, it, expect, afterEach } from 'vitest';
import { renderEmailHtml } from '../renderer';
import { registerBlock, unregisterBlock, getRegisteredBlocks } from '../blocks';
import type { EditorBlock } from '@owlat/shared';
import type { RenderContext } from '../types';

describe('Custom Block Registry', () => {
	afterEach(() => {
		// Clean up registered blocks
		for (const type of getRegisteredBlocks()) {
			unregisterBlock(type);
		}
	});

	it('renders custom blocks via registry', () => {
		registerBlock('qrCode', (content) => {
			const c = content as { url: string; size: number };
			return `<img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(c.url)}&size=${c.size}x${c.size}" alt="QR Code" width="${c.size}" />`;
		});

		const blocks = [
			{
				id: '1',
				type: 'qrCode',
				content: { url: 'https://example.com', size: 200 },
			},
		] as unknown as EditorBlock[];

		const html = renderEmailHtml(blocks);
		expect(html).toContain('qrserver.com');
		expect(html).toContain('200');
	});

	it('returns empty for unknown block types', () => {
		const blocks = [
			{
				id: '1',
				type: 'nonexistent',
				content: {},
			},
		] as unknown as EditorBlock[];

		const html = renderEmailHtml(blocks);
		// Should not crash, just skip the block — full document still rendered
		expect(html).toContain('<!DOCTYPE html>');
	});

	it('unregister removes custom blocks', () => {
		registerBlock('chart', () => '<div>Chart</div>');
		expect(getRegisteredBlocks()).toContain('chart');

		unregisterBlock('chart');
		expect(getRegisteredBlocks()).not.toContain('chart');
	});

	it('getRegisteredBlocks returns all custom types', () => {
		registerBlock('typeA', () => 'A');
		registerBlock('typeB', () => 'B');

		const types = getRegisteredBlocks();
		expect(types).toContain('typeA');
		expect(types).toContain('typeB');
		expect(types.length).toBe(2);
	});

	it('custom block receives render context', () => {
		let receivedCtx: RenderContext | null = null;
		registerBlock('ctxBlock', (_content, ctx) => {
			receivedCtx = ctx;
			return '<div>Custom</div>';
		});

		renderEmailHtml(
			[{ id: '1', type: 'ctxBlock', content: {} }] as unknown as EditorBlock[],
			{ baseWidth: 700, darkMode: true },
		);

		expect(receivedCtx).not.toBeNull();
		expect(receivedCtx.baseWidth).toBe(700);
		expect(receivedCtx.darkMode).toBe(true);
	});
});
