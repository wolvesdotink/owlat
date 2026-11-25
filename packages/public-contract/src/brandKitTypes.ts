/**
 * The brand kit: `/api/v1/brand-kit`. Plain TypeScript with no imports,
 * re-exported by `types.ts`; see there for why.
 *
 * The kit may gain fields in a later release. A client reads the fields it
 * knows and ignores the rest.
 */

/** A social link in the footer of every email. */
export interface BrandKitSocialLink {
	/** A platform such as `github`, `linkedin` or `bluesky`; the OpenAPI document lists them all. */
	platform: string;
	/** An absolute http(s) URL. */
	url: string;
}

/** A logo file of the kit, from the media library. */
export interface BrandKitLogo {
	url: string;
	/** Width in pixels, or `null` when the file does not say. */
	width: number | null;
}

/**
 * The organization's brand kit: the colours, fonts, button style, logo and
 * footer every email starts from. Until it is saved once, `isConfigured` is
 * false and every other field holds its default.
 */
export interface BrandKit {
	/** False until the kit is saved once, in the dashboard or through the API. */
	isConfigured: boolean;
	/** Hex colour such as `#c4785a`: buttons and accents. */
	primaryColor: string;
	/** Hex colour: dividers. */
	secondaryColor: string;
	/** Hex colour: body text. */
	textColor: string;
	/** Hex colour: the email background. */
	backgroundColor: string;
	/** Hex colour: links. */
	linkColor: string;
	/** Up to six more hex colours the editor's colour pickers offer. */
	swatches: string[];
	/** The CSS font stack of headings, one of the stacks the kit offers. */
	headingFontFamily: string;
	/** The CSS font stack of body text, one of the stacks the kit offers. */
	bodyFontFamily: string;
	/** Button corner radius in pixels. */
	buttonRadius: number;
	/** Button padding left and right, in pixels. */
	buttonPaddingX: number;
	/** Button padding top and bottom, in pixels. */
	buttonPaddingY: number;
	/** Email content width in pixels. */
	baseWidth: number;
	/** The company name above the postal address in the footer. */
	footerCompanyName: string;
	/** The postal address in the footer, one line per line. */
	footerAddress: string;
	footerSocialLinks: BrandKitSocialLink[];
	/** The email logo, or `null`. Set on the brand kit page; the API cannot change it. */
	logo: BrandKitLogo | null;
	/** The logo for dark mode, or `null`. Set on the brand kit page; the API cannot change it. */
	logoDark: BrandKitLogo | null;
}

/**
 * `PUT /api/v1/brand-kit`: the fields to change. A field left out keeps its
 * stored value. The logos and `isConfigured` cannot be written.
 */
export interface BrandKitInput {
	primaryColor?: string;
	secondaryColor?: string;
	textColor?: string;
	backgroundColor?: string;
	linkColor?: string;
	swatches?: string[];
	headingFontFamily?: string;
	bodyFontFamily?: string;
	buttonRadius?: number;
	buttonPaddingX?: number;
	buttonPaddingY?: number;
	baseWidth?: number;
	footerCompanyName?: string;
	footerAddress?: string;
	footerSocialLinks?: BrandKitSocialLink[];
}
