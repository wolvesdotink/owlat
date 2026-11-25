/**
 * One worked example per block type. The schema generator embeds each as the
 * `examples` of its block's `$defs` entry, and the block reference page in
 * the docs prints them. Tests validate every example against the schema and
 * render it, so an example that stops being valid content fails the build.
 *
 * Typed against `EditorBlock`, so the compiler checks each example too. The
 * examples carry the fields a write needs and a few optional ones a reader
 * would reach for; they are not meant to list every field.
 */

import type { BlockType, EditorBlock } from '@owlat/shared';

type ExampleOf<K extends BlockType> = Extract<EditorBlock, { type: K }>;

export const BLOCK_EXAMPLES: { [K in BlockType]: ExampleOf<K> } = {
	text: {
		id: 'greeting',
		type: 'text',
		content: {
			html: "<p>Hi {{first_name|'there'}}, your order <strong>{{order_number}}</strong> is on its way.</p>",
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#1f2937',
			lineHeight: 1.5,
			paddingTop: 8,
			paddingBottom: 8,
		},
	},
	image: {
		id: 'product-shot',
		type: 'image',
		content: {
			src: 'https://example.com/images/product.png',
			alt: 'The desk lamp in matte black',
			width: 100,
			align: 'center',
			linkUrl: 'https://example.com/products/desk-lamp',
		},
	},
	button: {
		id: 'track-order',
		type: 'button',
		content: {
			text: 'Track your order',
			url: 'https://example.com/orders/{{order_number}}',
			backgroundColor: '#4f46e5',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 6,
			paddingX: 24,
			paddingY: 12,
		},
	},
	divider: {
		id: 'rule',
		type: 'divider',
		content: {
			color: '#e5e7eb',
			thickness: 1,
			width: 100,
			style: 'solid',
			paddingTop: 16,
			paddingBottom: 16,
		},
	},
	spacer: {
		id: 'gap',
		type: 'spacer',
		content: { height: 24 },
	},
	columns: {
		id: 'product-row',
		type: 'columns',
		content: {
			columnCount: 2,
			ratio: 'right-wide',
			mobileStacking: true,
			columnGap: 16,
			columns: [
				[
					{
						id: 'product-row-image',
						type: 'image',
						content: {
							src: 'https://example.com/images/lamp-thumb.png',
							alt: 'Desk lamp',
							width: 100,
							align: 'center',
						},
					},
				],
				[
					{
						id: 'product-row-name',
						type: 'text',
						content: {
							html: '<p><strong>Desk lamp</strong><br>Matte black, warm white bulb</p>',
							blockType: 'paragraph',
							fontSize: 15,
							textColor: '#1f2937',
						},
					},
					{
						id: 'product-row-price',
						type: 'text',
						content: {
							html: '<p>€49.00</p>',
							blockType: 'paragraph',
							fontSize: 15,
							textColor: '#1f2937',
							textAlign: 'right',
						},
					},
				],
			],
		},
	},
	social: {
		id: 'follow',
		type: 'social',
		content: {
			links: [
				{ platform: 'mastodon', url: 'https://example.com/@owlat', enabled: true },
				{ platform: 'github', url: 'https://github.com/wolvesdotink/owlat', enabled: true },
			],
			iconStyle: 'filled',
			align: 'center',
			iconSize: 24,
			iconSpacing: 12,
			iconColor: '#4b5563',
		},
	},
	container: {
		id: 'summary-card',
		type: 'container',
		content: {
			maxWidth: 600,
			paddingTop: 24,
			paddingRight: 24,
			paddingBottom: 24,
			paddingLeft: 24,
			paddingLinked: true,
			marginTop: 0,
			marginRight: 0,
			marginBottom: 16,
			marginLeft: 0,
			borderWidth: 1,
			borderColor: '#e5e7eb',
			borderStyle: 'solid',
			borderRadius: 8,
			backgroundColor: '#f9fafb',
			items: [
				{
					id: 'summary-title',
					type: 'text',
					content: {
						html: 'Order summary',
						blockType: 'h2',
						fontSize: 20,
						textColor: '#111827',
					},
				},
				{
					id: 'summary-total',
					type: 'text',
					content: {
						html: '<p>Total: <strong>{{order_total}}</strong></p>',
						blockType: 'paragraph',
						fontSize: 16,
						textColor: '#1f2937',
					},
				},
			],
		},
	},
	hero: {
		id: 'launch-hero',
		type: 'hero',
		content: {
			backgroundImage: 'https://example.com/images/hero.jpg',
			backgroundPosition: 'center',
			backgroundSize: 'cover',
			height: 320,
			mode: 'fluid-height',
			verticalAlign: 'middle',
			overlayColor: 'rgba(17, 24, 39, 0.45)',
			backgroundColor: '#111827',
			items: [
				{
					id: 'launch-hero-title',
					type: 'text',
					content: {
						html: 'The new collection is here',
						blockType: 'h1',
						fontSize: 32,
						textColor: '#ffffff',
						textAlign: 'center',
					},
				},
				{
					id: 'launch-hero-cta',
					type: 'button',
					content: {
						text: 'Shop now',
						url: 'https://example.com/collection',
						backgroundColor: '#ffffff',
						textColor: '#111827',
						align: 'center',
						borderRadius: 999,
						paddingX: 28,
						paddingY: 12,
					},
				},
			],
		},
	},
	table: {
		id: 'invoice',
		type: 'table',
		content: {
			headers: ['Item', 'Qty', 'Price'],
			rows: [
				['Desk lamp', '1', '€49.00'],
				['Bulb, warm white', '2', '€9.00'],
			],
			footerRow: ['Total', '', '€58.00'],
			headerBackgroundColor: '#f3f4f6',
			headerTextColor: '#111827',
			borderColor: '#e5e7eb',
			striped: true,
			stripeColor: '#f9fafb',
			cellPadding: 10,
			textAlign: 'left',
			columns: [{ width: '60%' }, { width: '15%', textAlign: 'center' }, { textAlign: 'right' }],
			responsiveMode: 'stack',
		},
	},
	rawHtml: {
		id: 'legal-note',
		type: 'rawHtml',
		content: {
			html: '<p style="font-size: 12px; color: #6b7280">Prices include VAT. <a href="https://example.com/terms">Terms</a></p>',
			paddingTop: 8,
			paddingBottom: 8,
		},
	},
	video: {
		id: 'walkthrough',
		type: 'video',
		content: {
			thumbnailUrl: 'https://example.com/images/walkthrough.jpg',
			videoUrl: 'https://example.com/videos/walkthrough',
			alt: 'Watch the two-minute walkthrough',
			width: 100,
			align: 'center',
			playButtonColor: '#ffffff',
		},
	},
	accordion: {
		id: 'faq',
		type: 'accordion',
		content: {
			sections: [
				{
					id: 'faq-shipping',
					title: 'When will my order arrive?',
					items: [
						{
							id: 'faq-shipping-answer',
							type: 'text',
							content: {
								html: '<p>Most orders arrive within three working days.</p>',
								blockType: 'paragraph',
								fontSize: 15,
								textColor: '#1f2937',
							},
						},
					],
				},
				{
					id: 'faq-returns',
					title: 'Can I return it?',
					items: [
						{
							id: 'faq-returns-answer',
							type: 'text',
							content: {
								html: '<p>Yes, within 30 days.</p>',
								blockType: 'paragraph',
								fontSize: 15,
								textColor: '#1f2937',
							},
						},
					],
				},
			],
			initialExpanded: 0,
			headerBackgroundColor: '#f3f4f6',
			headerTextColor: '#111827',
		},
	},
	menu: {
		id: 'nav',
		type: 'menu',
		content: {
			items: [
				{ label: 'Shop', url: 'https://example.com/shop' },
				{ label: 'Orders', url: 'https://example.com/orders' },
				{ label: 'Help', url: 'https://example.com/help' },
			],
			align: 'center',
			fontSize: 14,
			textColor: '#374151',
			separator: '·',
		},
	},
	carousel: {
		id: 'gallery',
		type: 'carousel',
		content: {
			images: [
				{ src: 'https://example.com/images/lamp-front.jpg', alt: 'Lamp, front' },
				{ src: 'https://example.com/images/lamp-side.jpg', alt: 'Lamp, side' },
			],
			iconColor: '#111827',
		},
	},
	list: {
		id: 'next-steps',
		type: 'list',
		content: {
			items: ['Confirm your address', 'Pick a delivery day', 'Track the parcel'],
			listType: 'numbered',
			fontSize: 15,
			textColor: '#1f2937',
		},
	},
	progressBar: {
		id: 'onboarding-progress',
		type: 'progressBar',
		content: {
			value: 60,
			barColor: '#4f46e5',
			trackColor: '#e5e7eb',
			height: 8,
			showLabel: true,
			labelPosition: 'right',
		},
	},
};
