/**
 * Brand kit → editor Blocks: the logo and footer Blocks, the blocks a new
 * email starts with, and "Apply brand kit", which restyles an existing email.
 *
 * Shared because the server builds a new email's starting blocks and restyles
 * a template preset at create time, and the builder inserts the same logo and
 * footer and runs the same restyle on demand.
 */
import { escapeHtml, escapeHtmlWithBreaks } from './html';
import { mapChildBlockLists } from './blockTree';
import { DEFAULT_BLOCK_MARGIN, DEFAULT_BLOCK_PADDING } from './emailDefaults';
import {
	brandBlockStyles,
	isBrandHexColor,
	readableTextColor,
	type BrandKitDesign,
} from './brandKit';
import type {
	EditorBlock,
	ImageBlockContent,
	SocialBlockContent,
	TextBlockContent,
} from './types/blocks';

/** A logo file from the media library, as the editor needs it. */
export interface BrandLogoAsset {
	url: string;
	storageId: string;
	mediaAssetId: string;
	/** Intrinsic pixel width, when the media library knows it. */
	width?: number;
}

export interface BrandLogos {
	light: BrandLogoAsset | null;
	/** Shown instead of `light` when the recipient's client is in dark mode. */
	dark: BrandLogoAsset | null;
}

/** The widest a logo is drawn by default, in px. */
const LOGO_MAX_WIDTH = 180;

/**
 * Image Block widths are a percentage of the email width. A logo is drawn at
 * its own width up to {@link LOGO_MAX_WIDTH}, so a small mark is not blown up
 * and a wide banner is not drawn edge to edge.
 */
function logoWidthPercent(asset: BrandLogoAsset, baseWidth: number): number {
	const px = Math.min(
		asset.width && asset.width > 0 ? asset.width : LOGO_MAX_WIDTH,
		LOGO_MAX_WIDTH
	);
	return Math.max(10, Math.min(100, Math.round((px / baseWidth) * 100)));
}

/** The logo as an image Block, or `null` when the kit has no logo. */
export function brandLogoBlock(
	design: BrandKitDesign,
	logos: BrandLogos,
	newId: () => string
): EditorBlock | null {
	const light = logos.light;
	if (!light) return null;
	const content: ImageBlockContent = {
		src: light.url,
		storageId: light.storageId,
		mediaAssetId: light.mediaAssetId,
		alt: design.footerCompanyName || 'Logo',
		width: logoWidthPercent(light, design.baseWidth),
		align: 'center',
		...DEFAULT_BLOCK_PADDING,
		...DEFAULT_BLOCK_MARGIN,
	};
	if (logos.dark) {
		content.darkSrc = logos.dark.url;
		content.darkStorageId = logos.dark.storageId;
		content.darkMediaAssetId = logos.dark.mediaAssetId;
	}
	return { id: newId(), type: 'image', content };
}

/**
 * The footer: the company name and postal address as a small centred text
 * Block, then the social links as a social Block. Either part is left out when
 * the kit has nothing for it; `[]` when it has neither.
 */
export function brandFooterBlocks(design: BrandKitDesign, newId: () => string): EditorBlock[] {
	const blocks: EditorBlock[] = [];
	const name = design.footerCompanyName.trim();
	const address = design.footerAddress.trim();
	if (name || address) {
		const lines = [
			name ? `<strong>${escapeHtml(name)}</strong>` : '',
			address ? escapeHtmlWithBreaks(address) : '',
		].filter(Boolean);
		const content: TextBlockContent = {
			html: lines.join('<br>'),
			blockType: 'paragraph',
			fontSize: 12,
			textColor: design.textColor,
			textAlign: 'center',
			lineHeight: 1.6,
			...DEFAULT_BLOCK_PADDING,
			...DEFAULT_BLOCK_MARGIN,
		};
		blocks.push({ id: newId(), type: 'text', content });
	}
	if (design.footerSocialLinks.length > 0) {
		const content: SocialBlockContent = {
			links: design.footerSocialLinks.map((link) => ({ ...link, enabled: true })),
			iconStyle: 'filled',
			align: 'center',
			iconSize: 28,
			iconSpacing: 12,
			iconColor: design.primaryColor,
			...DEFAULT_BLOCK_PADDING,
			...DEFAULT_BLOCK_MARGIN,
		};
		blocks.push({ id: newId(), type: 'social', content });
	}
	return blocks;
}

/**
 * What a blank new email starts with: the logo on top and the footer at the
 * bottom. Empty when the kit is not configured, so an instance without a kit
 * keeps creating empty emails.
 */
export function brandStarterBlocks(
	design: BrandKitDesign,
	logos: BrandLogos,
	newId: () => string
): EditorBlock[] {
	if (!design.isConfigured) return [];
	const logo = brandLogoBlock(design, logos, newId);
	return [...(logo ? [logo] : []), ...brandFooterBlocks(design, newId)];
}

/** Font overrides "Apply brand kit" clears so the kit's heading and body fonts apply. */
const FONT_FIELDS: Partial<Record<EditorBlock['type'], string>> = {
	text: 'fontFamily',
	button: 'fontFamily',
	menu: 'fontFamily',
};

/**
 * Style fields that colour text. They are only rewritten on a surface of the
 * same tone as the kit's background: white text on a dark section stays
 * white, because the kit's text colour was picked for the kit's background.
 */
const TEXT_COLOR_FIELDS: ReadonlySet<string> = new Set(['textColor', 'headerTextColor']);

/** Fields whose own background decides where a type's text colour sits. */
const HEADER_SURFACE_FIELD: Partial<Record<EditorBlock['type'], string>> = {
	accordion: 'headerBackgroundColor',
	table: 'headerBackgroundColor',
};

type Tone = 'light' | 'dark' | 'unknown';

/** The tone of a background colour; `null` when it is unset or transparent (inherited). */
function toneOf(color: unknown): Tone | null {
	if (typeof color !== 'string' || color === '' || color === 'transparent') return null;
	if (!isBrandHexColor(color)) return 'unknown';
	return readableTextColor(color) === '#ffffff' ? 'dark' : 'light';
}

export interface ApplyBrandResult {
	blocks: EditorBlock[];
	/** Blocks whose content changed. */
	changedCount: number;
}

/**
 * Restyle `blocks` with the kit: each block type takes the colours, button
 * style and fonts {@link brandBlockStyles} names, at any depth. Content (text,
 * images, links) is never touched, and neither are colours set inside rich
 * text. Text colours change only where the text sits on a surface of the same
 * tone as the kit's background (a hero image counts as unknown). Blocks linked
 * to the saved-block library are left alone: they mirror the library and are
 * restyled there. Nothing is mutated.
 */
export function applyBrandKit(blocks: EditorBlock[], design: BrandKitDesign): ApplyBrandResult {
	const styles = brandBlockStyles(design);
	const pageTone = toneOf(design.backgroundColor) ?? 'light';
	let changedCount = 0;

	const visit = (block: EditorBlock, surface: Tone): EditorBlock => {
		const current = block.content as unknown as Record<string, unknown>;
		// A button's `backgroundColor` is its own fill, which the kit sets
		// together with a label colour that reads on it.
		const own = block.type === 'button' ? null : toneOf(current['backgroundColor']);
		const blockSurface = own ?? surface;
		const childSurface: Tone = block.type === 'hero' ? 'unknown' : blockSurface;
		const withChildren = mapChildBlockLists(block, (list) =>
			list.map((child) => visit(child, childSurface))
		);

		const headerField = HEADER_SURFACE_FIELD[block.type];
		const textSurface = headerField ? (toneOf(current[headerField]) ?? blockSurface) : blockSurface;
		const overlay: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(styles[block.type] ?? {})) {
			const isText = TEXT_COLOR_FIELDS.has(key) && block.type !== 'button';
			if (isText && textSurface !== pageTone) continue;
			overlay[key] = value;
		}
		const content = {
			...(withChildren.content as unknown as Record<string, unknown>),
			...overlay,
		};
		const fontField = FONT_FIELDS[block.type];
		if (fontField) delete content[fontField];
		const next = { ...withChildren, content } as unknown as EditorBlock;
		if (JSON.stringify(content) !== JSON.stringify(withChildren.content)) changedCount++;
		return next;
	};

	const next = blocks.map((block) => (block.savedBlockRef ? block : visit(block, pageTone)));
	return { blocks: next, changedCount };
}
