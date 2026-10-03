/**
 * The organization brand kit: one set of colours, fonts, button style, logo
 * and footer that every email starts from.
 *
 * The kit is stored in two columns of the settings row. `emailTheme` keeps the
 * four values it always held (primary colour, body font, background, width)
 * and `brandKit` holds the rest. Readers never look at the columns directly:
 * `resolveBrandKitDesign` merges them over the defaults, and
 * `brandKitEmailTheme` turns the result into the `EmailTheme` the renderer and
 * the builder consume. The server render, the editor canvas and the settings
 * preview all go through these two functions, so they cannot disagree.
 *
 * Pure and dependency-free (type imports only): it loads in the Convex
 * runtime, the renderer bundle and the browser.
 */
import { DEFAULT_EMAIL_THEME } from './emailDefaults';
import type { BlockType, BlockTypeContentMap, SocialPlatform } from './types/blocks';
import type { EmailTheme } from './types/editor';

/** Extra swatches an admin can add next to the five named colours. */
export const MAX_BRAND_SWATCHES = 6;
/** Social links the footer carries. */
export const MAX_BRAND_SOCIAL_LINKS = 8;
export const MAX_BRAND_COMPANY_NAME_LENGTH = 120;
export const MAX_BRAND_ADDRESS_LENGTH = 300;
export const MAX_BRAND_URL_LENGTH = 500;
export const BRAND_BUTTON_RADIUS_RANGE = { min: 0, max: 40 } as const;
export const BRAND_BUTTON_PADDING_X_RANGE = { min: 4, max: 64 } as const;
export const BRAND_BUTTON_PADDING_Y_RANGE = { min: 4, max: 32 } as const;
export const BRAND_BASE_WIDTH_RANGE = { min: 400, max: 800 } as const;

/** A font an admin can pick. `webFontUrl` is set for fonts loaded from Google Fonts. */
export interface BrandFont {
	/** Stable id; also the i18n key suffix for the label. */
	id: string;
	/** The CSS font stack written into the email, ending in an email-safe fallback. */
	stack: string;
	webFontUrl?: string;
}

const googleFont = (family: string) =>
	`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@400;700&display=swap`;

/**
 * The fonts on offer. The email-safe stacks render the same everywhere; the web
 * fonts load in clients that fetch remote fonts (Apple Mail, iOS, Thunderbird,
 * Samsung Mail) and fall back to the safe font named after them elsewhere
 * (Gmail, Outlook). The first eight stacks are the ones the email theme page
 * offered before the brand kit, spelled identically so stored themes still
 * match an option.
 */
export const BRAND_FONTS: readonly BrandFont[] = [
	{ id: 'arial', stack: 'Arial, sans-serif' },
	{ id: 'helvetica', stack: "'Helvetica Neue', Helvetica, sans-serif" },
	{ id: 'georgia', stack: 'Georgia, serif' },
	{ id: 'timesNewRoman', stack: "'Times New Roman', serif" },
	{ id: 'verdana', stack: 'Verdana, sans-serif' },
	{ id: 'trebuchetMs', stack: "'Trebuchet MS', sans-serif" },
	{ id: 'courierNew', stack: "'Courier New', monospace" },
	{ id: 'systemDefault', stack: 'system-ui, sans-serif' },
	{ id: 'inter', stack: "'Inter', Arial, sans-serif", webFontUrl: googleFont('Inter') },
	{ id: 'roboto', stack: "'Roboto', Arial, sans-serif", webFontUrl: googleFont('Roboto') },
	{ id: 'openSans', stack: "'Open Sans', Arial, sans-serif", webFontUrl: googleFont('Open Sans') },
	{ id: 'lato', stack: "'Lato', Arial, sans-serif", webFontUrl: googleFont('Lato') },
	{
		id: 'montserrat',
		stack: "'Montserrat', Arial, sans-serif",
		webFontUrl: googleFont('Montserrat'),
	},
	{ id: 'poppins', stack: "'Poppins', Arial, sans-serif", webFontUrl: googleFont('Poppins') },
	{
		id: 'merriweather',
		stack: "'Merriweather', Georgia, serif",
		webFontUrl: googleFont('Merriweather'),
	},
	{
		id: 'playfairDisplay',
		stack: "'Playfair Display', Georgia, serif",
		webFontUrl: googleFont('Playfair Display'),
	},
	{ id: 'lora', stack: "'Lora', Georgia, serif", webFontUrl: googleFont('Lora') },
];

export function brandFontByStack(stack: string): BrandFont | undefined {
	return BRAND_FONTS.find((font) => font.stack === stack);
}

/** The `emailTheme` column, as stored. */
export interface StoredEmailTheme {
	primaryColor: string;
	fontFamily: string;
	backgroundColor: string;
	baseWidth?: number;
}

export interface BrandSocialLink {
	platform: SocialPlatform;
	url: string;
}

/**
 * The `brandKit` column, as stored. Every field is optional so a partial row
 * written by an older client, or a field added later, still reads.
 */
export interface StoredBrandKit {
	secondaryColor?: string;
	textColor?: string;
	linkColor?: string;
	swatches?: string[];
	headingFontFamily?: string;
	buttonRadius?: number;
	buttonPaddingX?: number;
	buttonPaddingY?: number;
	logoMediaAssetId?: string;
	logoDarkMediaAssetId?: string;
	footerCompanyName?: string;
	footerAddress?: string;
	footerSocialLinks?: BrandSocialLink[];
}

/** Everything about the kit except the logo files, with defaults filled in. */
export interface BrandKitDesign {
	/** False until an admin saves the brand kit; the email theme alone applies until then. */
	isConfigured: boolean;
	primaryColor: string;
	secondaryColor: string;
	textColor: string;
	backgroundColor: string;
	linkColor: string;
	swatches: string[];
	headingFontFamily: string;
	bodyFontFamily: string;
	buttonRadius: number;
	buttonPaddingX: number;
	buttonPaddingY: number;
	baseWidth: number;
	footerCompanyName: string;
	footerAddress: string;
	footerSocialLinks: BrandSocialLink[];
}

/**
 * The kit before anyone edits it. The colours are the defaults new blocks
 * already used (text and list `#374151`, divider `#282D3A`, the renderer's
 * link blue), so turning the kit on without changing a value changes nothing.
 */
export const DEFAULT_BRAND_KIT_DESIGN: BrandKitDesign = {
	isConfigured: false,
	primaryColor: DEFAULT_EMAIL_THEME.primaryColor,
	secondaryColor: '#282d3a',
	textColor: '#374151',
	backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
	linkColor: DEFAULT_EMAIL_THEME.linkColor,
	swatches: [],
	headingFontFamily: DEFAULT_EMAIL_THEME.fontFamily,
	bodyFontFamily: DEFAULT_EMAIL_THEME.fontFamily,
	buttonRadius: 8,
	buttonPaddingX: 24,
	buttonPaddingY: 12,
	baseWidth: DEFAULT_EMAIL_THEME.baseWidth,
	footerCompanyName: '',
	footerAddress: '',
	footerSocialLinks: [],
};

/** Merge the two stored columns over the defaults. */
export function resolveBrandKitDesign(
	theme: StoredEmailTheme | undefined | null,
	kit: StoredBrandKit | undefined | null
): BrandKitDesign {
	const d = DEFAULT_BRAND_KIT_DESIGN;
	const body = theme?.fontFamily || d.bodyFontFamily;
	return {
		isConfigured: Boolean(kit),
		primaryColor: theme?.primaryColor || d.primaryColor,
		backgroundColor: theme?.backgroundColor || d.backgroundColor,
		bodyFontFamily: body,
		baseWidth: theme?.baseWidth || d.baseWidth,
		secondaryColor: kit?.secondaryColor || d.secondaryColor,
		textColor: kit?.textColor || d.textColor,
		linkColor: kit?.linkColor || d.linkColor,
		swatches: kit?.swatches ?? [],
		// A kit saved without a heading font uses the body font for headings.
		headingFontFamily: kit?.headingFontFamily || body,
		buttonRadius: kit?.buttonRadius ?? d.buttonRadius,
		buttonPaddingX: kit?.buttonPaddingX ?? d.buttonPaddingX,
		buttonPaddingY: kit?.buttonPaddingY ?? d.buttonPaddingY,
		footerCompanyName: kit?.footerCompanyName ?? '',
		footerAddress: kit?.footerAddress ?? '',
		footerSocialLinks: kit?.footerSocialLinks ?? [],
	};
}

/** The stylesheet URLs for the web fonts among `stacks`, without duplicates. */
export function brandWebFontUrls(...stacks: string[]): string[] {
	const urls = stacks
		.map((stack) => brandFontByStack(stack)?.webFontUrl)
		.filter((url): url is string => Boolean(url));
	return [...new Set(urls)];
}

function expandHex(hex: string): string | null {
	const raw = hex.trim().replace(/^#/, '');
	if (/^[0-9a-f]{3}$/i.test(raw)) {
		return raw
			.split('')
			.map((c) => c + c)
			.join('');
	}
	return /^[0-9a-f]{6}$/i.test(raw) ? raw : null;
}

/** `#rgb` or `#rrggbb`: the colours a brand kit stores. */
export function isBrandHexColor(value: string): boolean {
	return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

/**
 * Near-black or white, whichever reads better on `background`. The perceived
 * brightness formula and threshold are the ones the builder has always used
 * for a new button's label.
 */
export function readableTextColor(background: string): string {
	const hex = expandHex(background);
	if (!hex) return '#ffffff';
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#12110e' : '#ffffff';
}

type BlockDefaults = { [K in BlockType]?: Partial<BlockTypeContentMap[K]> };

/**
 * The style each block type takes from the kit: what a new block starts with
 * in the editor, and what "Apply brand kit" writes onto an existing one.
 */
export function brandBlockStyles(design: BrandKitDesign): BlockDefaults {
	const buttonText = readableTextColor(design.primaryColor);
	return {
		text: { textColor: design.textColor },
		button: {
			backgroundColor: design.primaryColor,
			textColor: buttonText,
			borderRadius: design.buttonRadius,
			paddingX: design.buttonPaddingX,
			paddingY: design.buttonPaddingY,
		},
		list: { textColor: design.textColor, bulletColor: design.primaryColor },
		menu: { textColor: design.textColor },
		divider: { color: design.secondaryColor },
		social: { iconColor: design.primaryColor },
		progressBar: { barColor: design.primaryColor },
		carousel: { iconColor: design.primaryColor },
		accordion: { headerTextColor: design.textColor, iconColor: design.primaryColor },
		table: { headerTextColor: design.textColor },
	};
}

/**
 * The `EmailTheme` for a resolved kit. Until the kit is configured this is
 * exactly the four-key theme the settings row always produced, so emails
 * render byte-for-byte as before; once it is, the kit's text and link colours,
 * heading font, web fonts and per-block styles join it.
 */
export function brandKitEmailTheme(design: BrandKitDesign): EmailTheme {
	const base: EmailTheme = {
		primaryColor: design.primaryColor,
		fontFamily: design.bodyFontFamily,
		backgroundColor: design.backgroundColor,
		baseWidth: design.baseWidth,
	};
	if (!design.isConfigured) return base;
	const fontUrls = brandWebFontUrls(design.headingFontFamily, design.bodyFontFamily);
	return {
		...base,
		headingFontFamily: design.headingFontFamily,
		bodyTextColor: design.textColor,
		linkColor: design.linkColor,
		blockDefaults: brandBlockStyles(design),
		...(fontUrls.length > 0 ? { fontUrls } : {}),
	};
}

/**
 * The colours the editor's pickers offer first: the five named colours, then
 * the extra swatches, without duplicates.
 */
export function brandSwatches(design: BrandKitDesign): string[] {
	const all = [
		design.primaryColor,
		design.secondaryColor,
		design.textColor,
		design.backgroundColor,
		design.linkColor,
		...design.swatches,
	].map((c) => c.toLowerCase());
	return [...new Set(all)];
}

/** What is wrong with a kit about to be saved, as an i18n key suffix, or `null`. */
export type BrandKitProblem =
	| 'invalidColor'
	| 'tooManySwatches'
	| 'unknownFont'
	| 'buttonOutOfRange'
	| 'widthOutOfRange'
	| 'companyNameTooLong'
	| 'addressTooLong'
	| 'tooManySocialLinks'
	| 'invalidSocialUrl';

const inRange = (value: number, range: { min: number; max: number }) =>
	Number.isFinite(value) && value >= range.min && value <= range.max;

/** An absolute http(s) URL, as a social link must be. */
export function isBrandLinkUrl(value: string): boolean {
	if (value.length > MAX_BRAND_URL_LENGTH) return false;
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
	} catch {
		return false;
	}
}

/**
 * Validate a design before it is saved. The settings form shows the problem;
 * the server repeats the check and refuses the write.
 */
export function brandKitDesignProblem(
	design: Omit<BrandKitDesign, 'isConfigured'>
): BrandKitProblem | null {
	const colors = [
		design.primaryColor,
		design.secondaryColor,
		design.textColor,
		design.backgroundColor,
		design.linkColor,
		...design.swatches,
	];
	if (!colors.every(isBrandHexColor)) return 'invalidColor';
	if (design.swatches.length > MAX_BRAND_SWATCHES) return 'tooManySwatches';
	if (!brandFontByStack(design.headingFontFamily) || !brandFontByStack(design.bodyFontFamily)) {
		return 'unknownFont';
	}
	if (
		!inRange(design.buttonRadius, BRAND_BUTTON_RADIUS_RANGE) ||
		!inRange(design.buttonPaddingX, BRAND_BUTTON_PADDING_X_RANGE) ||
		!inRange(design.buttonPaddingY, BRAND_BUTTON_PADDING_Y_RANGE)
	) {
		return 'buttonOutOfRange';
	}
	if (!inRange(design.baseWidth, BRAND_BASE_WIDTH_RANGE)) return 'widthOutOfRange';
	if (design.footerCompanyName.length > MAX_BRAND_COMPANY_NAME_LENGTH) return 'companyNameTooLong';
	if (design.footerAddress.length > MAX_BRAND_ADDRESS_LENGTH) return 'addressTooLong';
	if (design.footerSocialLinks.length > MAX_BRAND_SOCIAL_LINKS) return 'tooManySocialLinks';
	if (!design.footerSocialLinks.every((link) => isBrandLinkUrl(link.url))) {
		return 'invalidSocialUrl';
	}
	return null;
}
