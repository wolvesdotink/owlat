import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { renderEmailHtml } from '../renderer';
import { kitchenSinkBlocks, blockFixtures } from '../preview/fixtures';
import type { BlockType } from '@owlat/shared';

/**
 * Preview regression tests.
 *
 * These tests ensure every block type renders without throwing through the
 * full renderEmailHtml() pipeline. They also validate that the rendered
 * output contains expected content markers.
 *
 * Set GENERATE_PREVIEWS=1 to write HTML files to disk as a side effect:
 *   GENERATE_PREVIEWS=1 npx vitest run src/__tests__/preview.test.ts
 */

const GENERATE = process.env.GENERATE_PREVIEWS === '1';
const PKG_ROOT = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
const OUT_DIR = resolve(PKG_ROOT, 'previews');
const BLOCKS_DIR = resolve(OUT_DIR, 'blocks');

if (GENERATE) {
	mkdirSync(BLOCKS_DIR, { recursive: true });
}

describe('Kitchen sink preview', () => {
	it('renders all blocks without throwing', () => {
		const html = renderEmailHtml(kitchenSinkBlocks, {
			title: 'Kitchen Sink — All Email Blocks',
			preheaderText: 'Preview of all 18 email block types',
			inlineCss: true,
		});

		expect(html).toBeDefined();
		expect(html.length).toBeGreaterThan(1000);

		if (GENERATE) {
			writeFileSync(resolve(OUT_DIR, 'kitchen-sink.html'), html, 'utf-8');
		}
	});

	it('renders dark mode variant without throwing', () => {
		const html = renderEmailHtml(kitchenSinkBlocks, {
			title: 'Kitchen Sink — Dark Mode',
			darkMode: true,
			inlineCss: true,
		});

		expect(html).toBeDefined();
		expect(html.length).toBeGreaterThan(1000);

		if (GENERATE) {
			writeFileSync(resolve(OUT_DIR, 'kitchen-sink-dark.html'), html, 'utf-8');
		}
	});

	it('contains content from all block types', () => {
		const html = renderEmailHtml(kitchenSinkBlocks, { inlineCss: true });

		// Text
		expect(html).toContain('Spring Collection 2026');
		expect(html).toContain('Featured Products');
		expect(html).toContain('Welcome to our spring collection');

		// Image (embedded as base64 data URI)
		expect(html).toContain('data:image/png;base64,');

		// Button
		expect(html).toContain('Shop the Collection');

		// Divider — rendered as an hr or border
		expect(html).toContain('preview-divider');

		// Columns — product names
		expect(html).toContain('Linen Blazer');
		expect(html).toContain('Cotton Chinos');

		// Social — platform links
		expect(html).toContain('twitter.com/example');

		// Container — member exclusive CTA
		expect(html).toContain('Member Exclusive');
		expect(html).toContain('Claim Your Discount');

		// Hero — heading
		expect(html).toContain('New Season, New You');

		// Table — product data
		expect(html).toContain('Oxford Shirt');
		expect(html).toContain('$363.00');

		// Raw HTML — callout
		expect(html).toContain('custom HTML block');

		// Video — alt text
		expect(html).toContain('Behind the scenes');

		// Accordion — FAQ titles
		expect(html).toContain('return policy');
		expect(html).toContain('shipping take');

		// Menu — navigation links
		expect(html).toContain('Products');
		expect(html).toContain('Pricing');

		// Carousel — slide alts
		expect(html).toContain('New arrivals for spring');

		// List — feature items
		expect(html).toContain('Free shipping');
		expect(html).toContain('ethically sourced');

		// Progress bar — value
		expect(html).toContain('73');

	});
});

describe('Per-block previews', () => {
	const blockTypes = Object.keys(blockFixtures) as BlockType[];

	it.each(blockTypes)('%s — renders without throwing', (blockType) => {
		const blocks = blockFixtures[blockType];
		const html = renderEmailHtml(blocks, {
			title: `Block Preview — ${blockType}`,
			inlineCss: true,
		});

		expect(html).toBeDefined();
		expect(html).toContain('<!DOCTYPE');
		expect(html.length).toBeGreaterThan(500);

		if (GENERATE) {
			writeFileSync(resolve(BLOCKS_DIR, `${blockType}.html`), html, 'utf-8');
		}
	});
});
