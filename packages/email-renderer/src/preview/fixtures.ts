/**
 * Kitchen-sink fixtures for visual email block testing.
 * All 18 block types with realistic sample content.
 *
 * These fixtures are used by the preview generator and the vitest regression test.
 * They intentionally use inline EditorBlock objects to avoid importing from email-builder.
 *
 * All images are embedded as base64 data URIs from local PNG files in ./assets/
 * so previews work offline with no external dependencies.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { EditorBlock, BlockType } from '@owlat/shared';

// ---------------------------------------------------------------------------
// Asset helpers — read local PNGs and convert to data URIs
// ---------------------------------------------------------------------------

const ASSETS_DIR = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), 'assets');

const dataUri = (relativePath: string): string => {
	const bytes = readFileSync(resolve(ASSETS_DIR, relativePath));
	return `data:image/png;base64,${bytes.toString('base64')}`;
};

// Social icons live in apps/web/public/ for production use
const SOCIAL_ICONS_DIR = resolve(ASSETS_DIR, '../../../../../apps/web/public/social-icons/filled');

const socialDataUri = (platform: string): string => {
	const bytes = readFileSync(resolve(SOCIAL_ICONS_DIR, `${platform}.png`));
	return `data:image/png;base64,${bytes.toString('base64')}`;
};

// Pre-load all assets as data URIs
const assets = {
	// Social icons (from apps/web/public/social-icons/filled/)
	socialTwitter: socialDataUri('twitter'),
	socialFacebook: socialDataUri('facebook'),
	socialInstagram: socialDataUri('instagram'),
	socialLinkedin: socialDataUri('linkedin'),
	socialYoutube: socialDataUri('youtube'),
	socialTiktok: socialDataUri('tiktok'),
	socialGithub: socialDataUri('github'),
	// Content images
	heroProduct: dataUri('images/hero-product.png'),
	productA: dataUri('images/product-a.png'),
	productB: dataUri('images/product-b.png'),
	heroBg: dataUri('images/hero-bg.png'),
	videoThumb: dataUri('images/video-thumb.png'),
	carousel1: dataUri('images/carousel-1.png'),
	carousel2: dataUri('images/carousel-2.png'),
	carousel3: dataUri('images/carousel-3.png'),
};

// ---------------------------------------------------------------------------
// Section header helper — renders a small label above each block in the
// kitchen sink so you can identify what block type you're looking at.
// ---------------------------------------------------------------------------
const sectionLabel = (label: string, id: string): EditorBlock => ({
	id,
	type: 'text',
	content: {
		html: `<p style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#999;margin:0">${label}</p>`,
		blockType: 'paragraph',
		fontSize: 11,
		textColor: '#999999',
		paddingTop: 32,
		paddingBottom: 4,
		paddingLeft: 24,
		paddingRight: 24,
	},
});

// ---------------------------------------------------------------------------
// 1. Text blocks (paragraph + headings)
// ---------------------------------------------------------------------------

const textParagraph: EditorBlock = {
	id: 'preview-text-paragraph',
	type: 'text',
	content: {
		html: '<p>Welcome to our spring collection. We\'ve curated the finest pieces to help you transition into the new season with style and confidence. Each item has been hand-selected by our design team.</p>',
		blockType: 'paragraph',
		fontSize: 16,
		textColor: '#374151',
		lineHeight: 1.6,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

const textH1: EditorBlock = {
	id: 'preview-text-h1',
	type: 'text',
	content: {
		html: '<h1>Spring Collection 2026</h1>',
		blockType: 'h1',
		fontSize: 36,
		textColor: '#111827',
		fontWeight: 700,
		textAlign: 'center',
		lineHeight: 1.2,
		paddingTop: 24,
		paddingRight: 24,
		paddingBottom: 8,
		paddingLeft: 24,
	},
};

const textH2: EditorBlock = {
	id: 'preview-text-h2',
	type: 'text',
	content: {
		html: '<h2>Featured Products</h2>',
		blockType: 'h2',
		fontSize: 24,
		textColor: '#1f2937',
		fontWeight: 600,
		lineHeight: 1.3,
		paddingTop: 20,
		paddingRight: 24,
		paddingBottom: 8,
		paddingLeft: 24,
	},
};

const textH3: EditorBlock = {
	id: 'preview-text-h3',
	type: 'text',
	content: {
		html: '<h3>Limited Time Offer</h3>',
		blockType: 'h3',
		fontSize: 20,
		textColor: '#374151',
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: 1,
		lineHeight: 1.3,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 8,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 2. Image
// ---------------------------------------------------------------------------

const imageBlock: EditorBlock = {
	id: 'preview-image',
	type: 'image',
	content: {
		src: assets.heroProduct,
		alt: 'Spring collection hero image showcasing new arrivals',
		width: 100,
		align: 'center',
		fluidOnMobile: true,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 3. Button
// ---------------------------------------------------------------------------

const buttonBlock: EditorBlock = {
	id: 'preview-button',
	type: 'button',
	content: {
		text: 'Shop the Collection',
		url: 'https://example.com/shop',
		backgroundColor: '#c4785a',
		textColor: '#ffffff',
		align: 'center',
		borderRadius: 8,
		paddingX: 32,
		paddingY: 14,
		fontSize: 16,
		fontWeight: 700,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 4. Divider
// ---------------------------------------------------------------------------

const dividerBlock: EditorBlock = {
	id: 'preview-divider',
	type: 'divider',
	content: {
		color: '#e5e7eb',
		thickness: 1,
		width: 80,
		style: 'solid',
		align: 'center',
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 5. Spacer
// ---------------------------------------------------------------------------

const spacerBlock: EditorBlock = {
	id: 'preview-spacer',
	type: 'spacer',
	content: {
		height: 32,
	},
};

// ---------------------------------------------------------------------------
// 6. Columns (2 columns with content)
// ---------------------------------------------------------------------------

const columnsBlock: EditorBlock = {
	id: 'preview-columns',
	type: 'columns',
	content: {
		columnCount: 2,
		ratio: 'equal',
		mobileStacking: true,
		columnGap: 16,
		columns: [
			[
				{
					id: 'col1-img',
					type: 'image',
					content: {
						src: assets.productA,
						alt: 'Linen blazer in navy blue',
						width: 100,
						align: 'center',
						fluidOnMobile: true,
					},
				},
				{
					id: 'col1-text',
					type: 'text',
					content: {
						html: '<p><strong>Linen Blazer</strong><br/>Lightweight and breathable for warm days.</p>',
						blockType: 'paragraph',
						fontSize: 14,
						textColor: '#374151',
						lineHeight: 1.5,
						textAlign: 'center',
						paddingTop: 8,
					},
				},
				{
					id: 'col1-btn',
					type: 'button',
					content: {
						text: 'View Details',
						url: 'https://example.com/blazer',
						backgroundColor: '#c4785a',
						textColor: '#ffffff',
						align: 'center',
						borderRadius: 6,
						paddingX: 20,
						paddingY: 10,
						fontSize: 14,
					},
				},
			],
			[
				{
					id: 'col2-img',
					type: 'image',
					content: {
						src: assets.productB,
						alt: 'Cotton chinos in olive green',
						width: 100,
						align: 'center',
						fluidOnMobile: true,
					},
				},
				{
					id: 'col2-text',
					type: 'text',
					content: {
						html: '<p><strong>Cotton Chinos</strong><br/>Classic fit with a modern silhouette.</p>',
						blockType: 'paragraph',
						fontSize: 14,
						textColor: '#374151',
						lineHeight: 1.5,
						textAlign: 'center',
						paddingTop: 8,
					},
				},
				{
					id: 'col2-btn',
					type: 'button',
					content: {
						text: 'View Details',
						url: 'https://example.com/chinos',
						backgroundColor: '#c4785a',
						textColor: '#ffffff',
						align: 'center',
						borderRadius: 6,
						paddingX: 20,
						paddingY: 10,
						fontSize: 14,
					},
				},
			],
		],
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 7. Social
// ---------------------------------------------------------------------------

const socialBlock: EditorBlock = {
	id: 'preview-social',
	type: 'social',
	content: {
		links: [
			{ platform: 'twitter', url: 'https://twitter.com/example', enabled: true, iconUrl: assets.socialTwitter },
			{ platform: 'facebook', url: 'https://facebook.com/example', enabled: true, iconUrl: assets.socialFacebook },
			{ platform: 'instagram', url: 'https://instagram.com/example', enabled: true, iconUrl: assets.socialInstagram },
			{ platform: 'linkedin', url: 'https://linkedin.com/company/example', enabled: true, iconUrl: assets.socialLinkedin },
			{ platform: 'youtube', url: 'https://youtube.com/@example', enabled: true, iconUrl: assets.socialYoutube },
			{ platform: 'tiktok', url: 'https://tiktok.com/@example', enabled: true, iconUrl: assets.socialTiktok },
			{ platform: 'github', url: 'https://github.com/example', enabled: false, iconUrl: assets.socialGithub },
		],
		iconStyle: 'filled',
		align: 'center',
		iconSize: 64,
		iconSpacing: 12,
		iconColor: '#374151',
		showLabels: true,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 8. Container
// ---------------------------------------------------------------------------

const containerBlock: EditorBlock = {
	id: 'preview-container',
	type: 'container',
	content: {
		items: [
			{
				id: 'ctr-text',
				type: 'text',
				content: {
					html: '<h2 style="margin:0">Member Exclusive</h2>',
					blockType: 'h2',
					fontSize: 22,
					textColor: '#ffffff',
					fontWeight: 700,
					textAlign: 'center',
				},
			},
			{
				id: 'ctr-desc',
				type: 'text',
				content: {
					html: '<p style="margin:0">Get early access to new arrivals and an extra 15% off your next order.</p>',
					blockType: 'paragraph',
					fontSize: 15,
					textColor: '#f3f4f6',
					textAlign: 'center',
					lineHeight: 1.5,
					paddingTop: 8,
				},
			},
			{
				id: 'ctr-btn',
				type: 'button',
				content: {
					text: 'Claim Your Discount',
					url: 'https://example.com/member-offer',
					backgroundColor: '#ffffff',
					textColor: '#1f2937',
					align: 'center',
					borderRadius: 6,
					paddingX: 28,
					paddingY: 12,
					fontSize: 15,
					fontWeight: 700,
					paddingTop: 16,
				},
			},
		],
		maxWidth: 100,
		paddingTop: 32,
		paddingRight: 32,
		paddingBottom: 32,
		paddingLeft: 32,
		paddingLinked: false,
		marginTop: 0,
		marginRight: 0,
		marginBottom: 0,
		marginLeft: 0,
		backgroundColor: '#1f2937',
		borderWidth: 0,
		borderColor: '#e5e5e5',
		borderStyle: 'solid',
		borderRadius: 12,
	},
};

// ---------------------------------------------------------------------------
// 9. Hero
// ---------------------------------------------------------------------------

const heroBlock: EditorBlock = {
	id: 'preview-hero',
	type: 'hero',
	content: {
		backgroundImage: assets.heroBg,
		backgroundPosition: 'center',
		backgroundSize: 'cover',
		height: 400,
		mode: 'fixed-height',
		verticalAlign: 'middle',
		overlayColor: 'rgba(0,0,0,0.4)',
		items: [
			{
				id: 'hero-heading',
				type: 'text',
				content: {
					html: '<h1 style="margin:0">New Season, New You</h1>',
					blockType: 'h1',
					fontSize: 40,
					textColor: '#ffffff',
					fontWeight: 700,
					textAlign: 'center',
					lineHeight: 1.2,
				},
			},
			{
				id: 'hero-sub',
				type: 'text',
				content: {
					html: '<p style="margin:0">Discover our latest arrivals, handpicked for you.</p>',
					blockType: 'paragraph',
					fontSize: 18,
					textColor: '#e5e7eb',
					textAlign: 'center',
					lineHeight: 1.5,
					paddingTop: 12,
				},
			},
			{
				id: 'hero-cta',
				type: 'button',
				content: {
					text: 'Explore Now',
					url: 'https://example.com/new-arrivals',
					backgroundColor: '#c4785a',
					textColor: '#ffffff',
					align: 'center',
					borderRadius: 8,
					paddingX: 32,
					paddingY: 14,
					fontSize: 16,
					fontWeight: 700,
					paddingTop: 20,
				},
			},
		],
		paddingTop: 24,
		paddingRight: 24,
		paddingBottom: 24,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 10. Table
// ---------------------------------------------------------------------------

const tableBlock: EditorBlock = {
	id: 'preview-table',
	type: 'table',
	content: {
		headers: ['Product', 'Size', 'Price'],
		rows: [
			['Linen Blazer', 'M / L / XL', '$189.00'],
			['Cotton Chinos', 'S / M / L', '$79.00'],
			['Oxford Shirt', 'M / L', '$95.00'],
		],
		headerBackgroundColor: '#1f2937',
		headerTextColor: '#ffffff',
		borderColor: '#e5e7eb',
		striped: true,
		stripeColor: '#f9fafb',
		cellPadding: 12,
		textAlign: 'left',
		captionText: 'Spring collection pricing',
		footerRow: ['', 'Subtotal', '$363.00'],
		columns: [
			{ width: '50%', textAlign: 'left' },
			{ width: '25%', textAlign: 'center' },
			{ width: '25%', textAlign: 'right' },
		],
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 11. Raw HTML
// ---------------------------------------------------------------------------

const rawHtmlBlock: EditorBlock = {
	id: 'preview-rawhtml',
	type: 'rawHtml',
	content: {
		html: `
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation">
  <tr>
    <td style="padding:20px 24px;background-color:#fef3c7;border-left:4px solid #f59e0b;font-family:Arial,sans-serif;font-size:14px;color:#92400e;border-radius:4px">
      <strong>Note:</strong> This is a custom HTML block. Use it for content that needs special formatting beyond what the standard blocks provide.
    </td>
  </tr>
</table>`,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 12. Video
// ---------------------------------------------------------------------------

const videoBlock: EditorBlock = {
	id: 'preview-video',
	type: 'video',
	content: {
		thumbnailUrl: assets.videoThumb,
		videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		alt: 'Behind the scenes: making our spring collection',
		width: 100,
		align: 'center',
		playButtonColor: 'rgba(255,255,255,0.9)',
		playButtonSize: 64,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
		borderRadius: 8,
	},
};

// ---------------------------------------------------------------------------
// 13. Accordion
// ---------------------------------------------------------------------------

const accordionBlock: EditorBlock = {
	id: 'preview-accordion',
	type: 'accordion',
	content: {
		sections: [
			{
				id: 'acc-1',
				title: 'What is your return policy?',
				items: [
					{
						id: 'acc-1-text',
						type: 'text',
						content: {
							html: '<p>We offer a 30-day return policy on all unworn items. Simply initiate a return through your account dashboard and ship the item back using our prepaid label.</p>',
							blockType: 'paragraph',
							fontSize: 14,
							textColor: '#4b5563',
							lineHeight: 1.6,
						},
					},
				],
			},
			{
				id: 'acc-2',
				title: 'How long does shipping take?',
				items: [
					{
						id: 'acc-2-text',
						type: 'text',
						content: {
							html: '<p>Standard shipping takes 5-7 business days. Express shipping (2-3 business days) is available at checkout for an additional fee.</p>',
							blockType: 'paragraph',
							fontSize: 14,
							textColor: '#4b5563',
							lineHeight: 1.6,
						},
					},
				],
			},
			{
				id: 'acc-3',
				title: 'Do you ship internationally?',
				items: [
					{
						id: 'acc-3-text',
						type: 'text',
						content: {
							html: '<p>Yes! We ship to over 50 countries. International shipping typically takes 7-14 business days depending on your location. Duties and taxes may apply.</p>',
							blockType: 'paragraph',
							fontSize: 14,
							textColor: '#4b5563',
							lineHeight: 1.6,
						},
					},
				],
			},
		],
		allowMultiple: false,
		initialExpanded: 0,
		headerBackgroundColor: '#f3f4f6',
		headerTextColor: '#1f2937',
		headerFontSize: 16,
		contentBackgroundColor: '#ffffff',
		iconColor: '#6b7280',
		sectionBorderColor: '#e5e7eb',
		borderRadius: 8,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 14. Menu
// ---------------------------------------------------------------------------

const menuBlock: EditorBlock = {
	id: 'preview-menu',
	type: 'menu',
	content: {
		items: [
			{ label: 'Home', url: 'https://example.com' },
			{ label: 'Products', url: 'https://example.com/products' },
			{ label: 'Pricing', url: 'https://example.com/pricing' },
			{ label: 'Blog', url: 'https://example.com/blog' },
			{ label: 'Contact', url: 'https://example.com/contact' },
		],
		align: 'center',
		fontSize: 14,
		textColor: '#374151',
		fontWeight: 500,
		separator: '|',
		separatorColor: '#d1d5db',
		itemSpacing: 16,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 15. Carousel
// ---------------------------------------------------------------------------

const carouselBlock: EditorBlock = {
	id: 'preview-carousel',
	type: 'carousel',
	content: {
		images: [
			{
				src: assets.carousel1,
				alt: 'New arrivals for spring',
				linkUrl: 'https://example.com/new',
			},
			{
				src: assets.carousel2,
				alt: 'Our best-selling items',
				linkUrl: 'https://example.com/best-sellers',
			},
			{
				src: assets.carousel3,
				alt: 'Items currently on sale',
				linkUrl: 'https://example.com/sale',
			},
		],
		iconWidth: 12,
		iconColor: '#c4785a',
		iconInactiveColor: '#d1d5db',
		thumbnailWidth: 0,
		borderRadius: 8,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 16. List
// ---------------------------------------------------------------------------

const listBlock: EditorBlock = {
	id: 'preview-list',
	type: 'list',
	content: {
		items: [
			'Free shipping on orders over $75',
			'30-day hassle-free returns',
			'Sustainable, ethically sourced materials',
			'Exclusive member discounts up to 20% off',
		],
		listType: 'check',
		bulletColor: '#16a34a',
		fontSize: 15,
		textColor: '#374151',
		itemSpacing: 8,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ---------------------------------------------------------------------------
// 17. Progress Bar
// ---------------------------------------------------------------------------

const progressBarBlock: EditorBlock = {
	id: 'preview-progressbar',
	type: 'progressBar',
	content: {
		value: 73,
		maxValue: 100,
		barColor: '#c4785a',
		trackColor: '#e5e7eb',
		height: 24,
		borderRadius: 12,
		showLabel: true,
		labelPosition: 'right',
		labelColor: '#374151',
		labelFontSize: 14,
		paddingTop: 16,
		paddingRight: 24,
		paddingBottom: 16,
		paddingLeft: 24,
	},
};

// ===========================================================================
// Kitchen Sink — all blocks in presentation order
// ===========================================================================

export const kitchenSinkBlocks: EditorBlock[] = [
	// Navigation
	sectionLabel('Menu', 'label-menu'),
	menuBlock,

	// Hero
	sectionLabel('Hero', 'label-hero'),
	heroBlock,

	// Spacer
	sectionLabel('Spacer', 'label-spacer'),
	spacerBlock,

	// Headings
	sectionLabel('Text: H1', 'label-h1'),
	textH1,
	sectionLabel('Text: H2', 'label-h2'),
	textH2,
	sectionLabel('Text: H3', 'label-h3'),
	textH3,

	// Paragraph
	sectionLabel('Text: Paragraph', 'label-paragraph'),
	textParagraph,

	// Image
	sectionLabel('Image', 'label-image'),
	imageBlock,

	// Button
	sectionLabel('Button', 'label-button'),
	buttonBlock,

	// Divider
	sectionLabel('Divider', 'label-divider'),
	dividerBlock,

	// Columns
	sectionLabel('Columns (2-column layout)', 'label-columns'),
	columnsBlock,

	// Container
	sectionLabel('Container', 'label-container'),
	containerBlock,

	// Table
	sectionLabel('Table', 'label-table'),
	tableBlock,

	// List
	sectionLabel('List (check style)', 'label-list'),
	listBlock,

	// Progress Bar
	sectionLabel('Progress Bar', 'label-progressbar'),
	progressBarBlock,

	// Social
	sectionLabel('Social Links', 'label-social'),
	socialBlock,

	// Carousel
	sectionLabel('Carousel', 'label-carousel'),
	carouselBlock,

	// Video
	sectionLabel('Video', 'label-video'),
	videoBlock,

	// Accordion
	sectionLabel('Accordion (FAQ)', 'label-accordion'),
	accordionBlock,

	// Raw HTML
	sectionLabel('Raw HTML', 'label-rawhtml'),
	rawHtmlBlock,
];

// ===========================================================================
// Per-block fixtures — keyed by block type
// ===========================================================================

export const blockFixtures: Record<BlockType, EditorBlock[]> = {
	text: [textH1, textH2, textH3, textParagraph],
	image: [imageBlock],
	button: [buttonBlock],
	divider: [dividerBlock],
	spacer: [spacerBlock],
	columns: [columnsBlock],
	social: [socialBlock],
	container: [containerBlock],
	hero: [heroBlock],
	table: [tableBlock],
	rawHtml: [rawHtmlBlock],
	video: [videoBlock],
	accordion: [accordionBlock],
	menu: [menuBlock],
	carousel: [carouselBlock],
	list: [listBlock],
	progressBar: [progressBarBlock],
};
