import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND_KIT_DESIGN, type BrandKitDesign } from '../brandKit';
import {
	applyBrandKit,
	brandFooterBlocks,
	brandLogoBlock,
	brandStarterBlocks,
	type BrandLogos,
} from '../brandKitBlocks';
import type { EditorBlock } from '../types/blocks';

const design: BrandKitDesign = {
	...DEFAULT_BRAND_KIT_DESIGN,
	isConfigured: true,
	primaryColor: '#0f766e',
	secondaryColor: '#94a3b8',
	textColor: '#1f2937',
	headingFontFamily: 'Georgia, serif',
	buttonRadius: 20,
	buttonPaddingX: 30,
	buttonPaddingY: 14,
	footerCompanyName: 'Northwind <Studio>',
	footerAddress: '1 Example Street\n12345 Example City',
	footerSocialLinks: [{ platform: 'github', url: 'https://github.com/example' }],
};

const logos: BrandLogos = {
	light: {
		url: 'https://cdn.example.com/logo.png',
		storageId: 's1',
		mediaAssetId: 'm1',
		width: 120,
	},
	dark: { url: 'https://cdn.example.com/logo-dark.png', storageId: 's2', mediaAssetId: 'm2' },
};

const ids = () => {
	let n = 0;
	return () => `b${n++}`;
};

describe('brandLogoBlock', () => {
	it('is an image Block carrying both logo files, drawn at the logo width', () => {
		const block = brandLogoBlock(design, logos, ids());
		expect(block).toMatchObject({
			type: 'image',
			content: {
				src: 'https://cdn.example.com/logo.png',
				storageId: 's1',
				mediaAssetId: 'm1',
				darkSrc: 'https://cdn.example.com/logo-dark.png',
				darkStorageId: 's2',
				darkMediaAssetId: 'm2',
				alt: 'Northwind <Studio>',
				width: 20,
				align: 'center',
			},
		});
	});

	it('caps a wide logo and is null without one', () => {
		const wide = { ...logos, light: { ...logos.light!, width: 2000 } };
		expect(brandLogoBlock(design, wide, ids())?.content).toMatchObject({ width: 30 });
		expect(brandLogoBlock(design, { light: null, dark: null }, ids())).toBeNull();
	});
});

describe('brandFooterBlocks', () => {
	it('escapes the company details and keeps the address line breaks', () => {
		const [text, social] = brandFooterBlocks(design, ids());
		expect(text?.type).toBe('text');
		expect((text?.content as { html: string }).html).toBe(
			'<strong>Northwind &lt;Studio&gt;</strong><br>1 Example Street<br>12345 Example City'
		);
		expect(social).toMatchObject({
			type: 'social',
			content: {
				links: [{ platform: 'github', url: 'https://github.com/example', enabled: true }],
				iconColor: '#0f766e',
			},
		});
	});

	it('is empty when the kit has no footer content', () => {
		expect(
			brandFooterBlocks(
				{ ...design, footerCompanyName: '', footerAddress: ' ', footerSocialLinks: [] },
				ids()
			)
		).toEqual([]);
	});
});

describe('brandStarterBlocks', () => {
	it('is the logo then the footer, with distinct ids', () => {
		const blocks = brandStarterBlocks(design, logos, ids());
		expect(blocks.map((b) => b.type)).toEqual(['image', 'text', 'social']);
		expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
	});

	it('is empty until the kit is configured', () => {
		expect(brandStarterBlocks({ ...design, isConfigured: false }, logos, ids())).toEqual([]);
	});
});

const text = (id: string, extra: Record<string, unknown> = {}): EditorBlock =>
	({
		id,
		type: 'text',
		content: { html: 'Hi', blockType: 'paragraph', fontSize: 16, textColor: '#000000', ...extra },
	}) as EditorBlock;

describe('applyBrandKit', () => {
	it('restyles buttons and text, clears font overrides, and leaves content alone', () => {
		const blocks = [
			text('t1', { fontFamily: 'Verdana, sans-serif' }),
			{
				id: 'b1',
				type: 'button',
				content: {
					text: 'Go',
					url: 'https://example.com',
					backgroundColor: '#ff0000',
					textColor: '#ffffff',
					align: 'center',
					borderRadius: 0,
					paddingX: 10,
					paddingY: 5,
				},
			} as EditorBlock,
		];
		const { blocks: next, changedCount } = applyBrandKit(blocks, design);
		expect(changedCount).toBe(2);
		expect(next[0]!.content).toEqual({
			html: 'Hi',
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#1f2937',
		});
		expect(next[1]!.content).toMatchObject({
			text: 'Go',
			url: 'https://example.com',
			backgroundColor: '#0f766e',
			textColor: '#ffffff',
			borderRadius: 20,
			paddingX: 30,
			paddingY: 14,
		});
		// Nothing mutated.
		expect((blocks[0]!.content as { textColor: string }).textColor).toBe('#000000');
	});

	it('keeps text colours on a dark section and inside a hero, and recurses into children', () => {
		const blocks = [
			{
				id: 'c1',
				type: 'container',
				content: { items: [text('t1', { textColor: '#ffffff' })], backgroundColor: '#111827' },
			} as unknown as EditorBlock,
			{
				id: 'h1',
				type: 'hero',
				content: { items: [text('t2', { textColor: '#ffffff' })] },
			} as unknown as EditorBlock,
			{
				id: 'c2',
				type: 'container',
				content: { items: [text('t3')], backgroundColor: '#f8fafc' },
			} as unknown as EditorBlock,
		];
		const { blocks: next } = applyBrandKit(blocks, design);
		const child = (i: number) =>
			(next[i]!.content as unknown as { items: EditorBlock[] }).items[0]!.content as {
				textColor: string;
			};
		expect(child(0).textColor).toBe('#ffffff');
		expect(child(1).textColor).toBe('#ffffff');
		expect(child(2).textColor).toBe('#1f2937');
	});

	it('skips blocks linked to the saved-block library', () => {
		const linked = {
			...text('t1'),
			savedBlockRef: { blockId: 'sb1', groupId: 'g1', blockName: 'Header' },
		} as EditorBlock;
		const { blocks: next, changedCount } = applyBrandKit([linked], design);
		expect(next[0]).toBe(linked);
		expect(changedCount).toBe(0);
	});

	it('counts nothing when the email already matches the kit', () => {
		const once = applyBrandKit([text('t1')], design).blocks;
		expect(applyBrandKit(once, design).changedCount).toBe(0);
	});
});
