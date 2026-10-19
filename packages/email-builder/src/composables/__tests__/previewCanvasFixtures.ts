/**
 * Deterministic email canvases for the report-only preview benchmark (plan item
 * OW-072), checked for fidelity in usePreview.perf.test.ts.
 *
 * Every Block comes from the editor's own factories (`createBlock`,
 * `createColumnItem` in utils/blocks.ts), so it carries exactly the defaults a
 * Block dragged onto the canvas has; only the copy, URLs and the ids (made
 * stable here) are filled in. Images point at URLs, as uploads do, never at
 * data URIs. Copy uses personalization tokens the preview fills.
 *
 * Three sizes: a transactional receipt, a typical newsletter and a long digest.
 * Each comes with an edited twin (one paragraph changed), so a benchmark that
 * alternates them makes every regenerate diff against a different previous
 * render, as an edit followed by a preview does.
 */
import type { BlockType, ColumnItem, EditorBlock } from '../../types';
import { createBlock, createColumnItem } from '../../utils/blocks';

const CDN = 'https://cdn.owlat.example/media';
const SITE = 'https://owlat.example';

const PARAGRAPH =
	'We shipped the new scheduling view this week. It shows every send on one calendar, ' +
	'flags overlaps before they happen and lets you move a campaign with a drag. ' +
	'<strong>Teams on the beta cut double sends by half.</strong> ' +
	`<a href="${SITE}/blog/scheduling">Read how it works</a>, or reply to this email with questions.`;

/** Assigns stable ids in creation order, so two builds are identical. */
class CanvasBuilder {
	private next = 0;
	private id(prefix: string): string {
		this.next += 1;
		return `${prefix}-${this.next}`;
	}

	block(type: BlockType, content: Record<string, unknown> = {}): EditorBlock {
		const base = createBlock(type);
		return { ...base, id: this.id(type), content: { ...base.content, ...content } } as EditorBlock;
	}

	item(type: ColumnItem['type'], content: Record<string, unknown> = {}): ColumnItem {
		const base = createColumnItem(type);
		return {
			...base,
			id: this.id(`col-${type}`),
			content: { ...base.content, ...content },
		} as ColumnItem;
	}

	text(html: string, blockType: 'paragraph' | 'h1' | 'h2' | 'h3' = 'paragraph'): EditorBlock {
		return this.block('text', { html, blockType, ...(blockType === 'h1' ? { fontSize: 28 } : {}) });
	}

	image(name: string, alt: string): EditorBlock {
		return this.block('image', { src: `${CDN}/${name}.jpg`, alt, linkUrl: `${SITE}/${name}` });
	}

	button(text: string, path: string): EditorBlock {
		return this.block('button', { text, url: `${SITE}/${path}` });
	}

	/** A two-column product row: image, copy and a button in each column. */
	productRow(index: number): EditorBlock {
		const column = (side: string) => [
			this.item('image', {
				src: `${CDN}/product-${index}-${side}.jpg`,
				alt: `Product ${index} ${side}`,
			}),
			this.item('text', {
				html: `<strong>Field kit ${index}${side}</strong><br>Waxed canvas, made to order.`,
			}),
			this.item('button', { text: 'Shop now', url: `${SITE}/shop/${index}${side}` }),
		];
		return this.block('columns', { columns: [column('a'), column('b')] });
	}

	/** One article: heading, body copy with a link and a call to action. */
	article(index: number, body = PARAGRAPH): EditorBlock[] {
		return [
			this.text(`What changed in release ${index}`, 'h2'),
			this.text(`Hi {{first_name}}, ${body}`),
			this.button('Read the full story', `blog/release-${index}`),
		];
	}

	header(): EditorBlock[] {
		return [
			this.image('logo', 'Owlat'),
			this.block('menu', {
				items: [
					{ label: 'Product', url: `${SITE}/product` },
					{ label: 'Blog', url: `${SITE}/blog` },
					{ label: 'Pricing', url: `${SITE}/pricing` },
				],
			}),
		];
	}

	footer(): EditorBlock[] {
		return [
			this.block('divider'),
			this.block('social', {
				links: [
					{ platform: 'twitter', url: 'https://twitter.example/owlat', enabled: true },
					{ platform: 'linkedin', url: 'https://linkedin.example/owlat', enabled: true },
					{ platform: 'instagram', url: 'https://instagram.example/owlat', enabled: true },
				],
			}),
			this.text(
				'Owlat Example, 1 Example Street, Example City. You get this because you signed up at owlat.example.'
			),
		];
	}
}

function receipt(edited: boolean): EditorBlock[] {
	const b = new CanvasBuilder();
	return [
		b.image('logo', 'Example Shop'),
		b.text('Thanks for your order, {{first_name}}', 'h1'),
		b.text(
			edited
				? 'Your order is packed and leaves our warehouse tomorrow morning.'
				: 'We received your order and will email you again when it ships.'
		),
		b.block('table', {
			headers: ['Item', 'Qty', 'Price'],
			rows: [
				['Waxed canvas tote', '1', '€89.00'],
				['Leather strap', '2', '€24.00'],
				['Care kit', '1', '€12.50'],
				['Shipping', '', '€4.90'],
			],
		}),
		b.text('<strong>Total: €154.40</strong> (incl. VAT)'),
		b.button('Track your order', 'orders/track'),
		b.block('divider'),
		b.text('Questions? Reply to this email or write to support@owlat.example.'),
	];
}

function newsletter(edited: boolean): EditorBlock[] {
	const b = new CanvasBuilder();
	const articles = Array.from({ length: 6 }, (_, i) =>
		b.article(i + 1, edited && i === 2 ? `${PARAGRAPH} Updated after launch.` : PARAGRAPH)
	).flat();
	return [
		...b.header(),
		b.text('The October update', 'h1'),
		b.text('Hi {{first_name}}, here is what happened at Owlat this month.'),
		b.image('hero-october', 'The new scheduling calendar'),
		...articles.slice(0, 9),
		b.productRow(1),
		b.productRow(2),
		...articles.slice(9),
		b.productRow(3),
		b.block('list', {
			items: ['Calendar view for sends', 'Overlap warnings', 'Drag to reschedule'],
		}),
		...b.footer(),
	];
}

function digest(edited: boolean): EditorBlock[] {
	const b = new CanvasBuilder();
	const body: EditorBlock[] = [];
	for (let i = 0; i < 40; i++) {
		body.push(
			...b.article(i + 1, edited && i === 20 ? `${PARAGRAPH} Updated after launch.` : PARAGRAPH)
		);
		if (i % 4 === 3) body.push(b.productRow(i + 1));
	}
	return [...b.header(), b.text('Everything we shipped this year', 'h1'), ...body, ...b.footer()];
}

export interface PreviewCanvas {
	name: string;
	/** Whether the mandatory unsubscribe footer is on, as for a marketing template. */
	marketing: boolean;
	blocks: EditorBlock[];
	/** The same canvas with one paragraph edited. */
	edited: EditorBlock[];
}

export function previewCanvases(): PreviewCanvas[] {
	return [
		{ name: 'receipt', marketing: false, blocks: receipt(false), edited: receipt(true) },
		{ name: 'newsletter', marketing: true, blocks: newsletter(false), edited: newsletter(true) },
		{ name: 'digest', marketing: true, blocks: digest(false), edited: digest(true) },
	];
}

/** Top-level Blocks plus the items inside columns: what the renderer expands. */
export function countBlocks(blocks: readonly EditorBlock[]): number {
	let count = 0;
	for (const block of blocks) {
		count += 1;
		if (block.type === 'columns') {
			for (const column of (block.content as { columns: ColumnItem[][] }).columns)
				count += column.length;
		}
	}
	return count;
}
