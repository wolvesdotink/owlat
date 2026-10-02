/**
 * Validators for the brand kit: the `emailTheme` and `brandKit` columns of the
 * settings row, and the `workspaces/brandKit` arguments that write them. One
 * home, so the schema field and the mutation argument cannot drift apart.
 *
 * The shapes mirror `StoredEmailTheme` / `StoredBrandKit` in
 * `@owlat/shared/brandKit`, which every reader resolves through.
 */

import { v } from 'convex/values';
import { SOCIAL_PLATFORMS, type SocialPlatform } from '@owlat/shared/types';
import { literalUnion } from '../literalUnion';

export const socialPlatformValidator = literalUnion(
	Object.keys(SOCIAL_PLATFORMS) as SocialPlatform[]
);

/** The four theme values every email has always taken from the settings row. */
export const emailThemeValidator = v.object({
	primaryColor: v.string(), // Main brand color (e.g., button backgrounds)
	fontFamily: v.string(), // Font for email content
	backgroundColor: v.string(), // Email body background color
	baseWidth: v.optional(v.number()), // Base content width in px (default: 600)
});

/**
 * The rest of the brand kit. Its presence is what marks the kit as configured;
 * every field inside stays optional so a row an older client wrote reads.
 */
export const brandKitValidator = v.object({
	secondaryColor: v.optional(v.string()),
	textColor: v.optional(v.string()),
	linkColor: v.optional(v.string()),
	swatches: v.optional(v.array(v.string())),
	headingFontFamily: v.optional(v.string()),
	buttonRadius: v.optional(v.number()),
	buttonPaddingX: v.optional(v.number()),
	buttonPaddingY: v.optional(v.number()),
	// Logo files, from the media library. A deleted asset reads as no logo.
	logoMediaAssetId: v.optional(v.id('mediaAssets')),
	logoDarkMediaAssetId: v.optional(v.id('mediaAssets')),
	footerCompanyName: v.optional(v.string()),
	footerAddress: v.optional(v.string()),
	footerSocialLinks: v.optional(
		v.array(v.object({ platform: socialPlatformValidator, url: v.string() }))
	),
});
