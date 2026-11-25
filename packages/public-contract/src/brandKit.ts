/**
 * The brand kit (`/api/v1/brand-kit`).
 *
 * The write schema checks types, and that a social link names a known
 * platform. The values (hex colours, the fonts on offer, the ranges and
 * lengths) are checked by the server with the function the dashboard's brand
 * kit page uses, which names the field at fault; the limits written into these
 * schemas only describe that check in the document.
 */

import { z } from 'zod';
import {
	BRAND_BASE_WIDTH_RANGE,
	BRAND_BUTTON_PADDING_X_RANGE,
	BRAND_BUTTON_PADDING_Y_RANGE,
	BRAND_BUTTON_RADIUS_RANGE,
	BRAND_FONTS,
	MAX_BRAND_ADDRESS_LENGTH,
	MAX_BRAND_COMPANY_NAME_LENGTH,
	MAX_BRAND_SOCIAL_LINKS,
	MAX_BRAND_SWATCHES,
	MAX_BRAND_URL_LENGTH,
} from '@owlat/shared/brandKit';
import { SOCIAL_PLATFORMS } from '@owlat/shared/types';

const PLATFORMS = Object.keys(SOCIAL_PLATFORMS);
const FONT_STACKS = BRAND_FONTS.map((font) => font.stack);
const WEB_FONT_STACKS = BRAND_FONTS.filter((font) => font.webFontUrl).map((font) => font.stack);

const string = (field: string) => z.string({ error: `${field} must be a string` });
const number = (field: string) => z.number({ error: `${field} must be a number` });

const color = (field: string, use: string) =>
	string(field).meta({ description: `${use} A hex colour: #rgb or #rrggbb.` });

const fontDescription = `One of the CSS font stacks the brand kit offers, spelled exactly as listed. The web fonts among them (${WEB_FONT_STACKS.join('; ')}) load from Google Fonts in clients that fetch remote fonts, such as Apple Mail, and fall back to the font named after them elsewhere, such as Gmail and Outlook.`;

const font = (field: string, use: string) =>
	string(field).meta({ description: `${use} ${fontDescription}`, enum: FONT_STACKS });

const pixels = (field: string, range: { min: number; max: number }, use: string) =>
	number(field).meta({ description: `${use} In pixels.`, minimum: range.min, maximum: range.max });

const socialLinkSchema = z.strictObject(
	{
		platform: string('A social link platform')
			.refine((platform) => PLATFORMS.includes(platform), {
				error: 'A social link platform must be one the brand kit offers',
			})
			.meta({ enum: PLATFORMS }),
		url: string('A social link url').meta({
			description: 'An absolute http(s) URL.',
			maxLength: MAX_BRAND_URL_LENGTH,
		}),
	},
	{ error: 'Each social link must be an object of platform and url' }
);

const designShape = {
	primaryColor: color('primaryColor', 'Buttons and accents.'),
	secondaryColor: color('secondaryColor', 'Dividers.'),
	textColor: color('textColor', 'Body text.'),
	backgroundColor: color('backgroundColor', 'The email background.'),
	linkColor: color('linkColor', 'Links.'),
	swatches: z
		.array(z.string({ error: 'Each swatch must be a string' }), {
			error: 'swatches must be an array of strings',
		})
		.meta({
			description:
				'More hex colours the colour pickers of the editors offer, stored in lower case.',
			maxItems: MAX_BRAND_SWATCHES,
		}),
	headingFontFamily: font('headingFontFamily', 'The font of headings.'),
	bodyFontFamily: font('bodyFontFamily', 'The font of body text.'),
	buttonRadius: pixels('buttonRadius', BRAND_BUTTON_RADIUS_RANGE, 'Button corner radius.'),
	buttonPaddingX: pixels(
		'buttonPaddingX',
		BRAND_BUTTON_PADDING_X_RANGE,
		'Button padding left and right.'
	),
	buttonPaddingY: pixels(
		'buttonPaddingY',
		BRAND_BUTTON_PADDING_Y_RANGE,
		'Button padding top and bottom.'
	),
	baseWidth: pixels('baseWidth', BRAND_BASE_WIDTH_RANGE, 'Email content width.'),
	footerCompanyName: string('footerCompanyName').meta({
		description: 'The company name above the postal address in the footer.',
		maxLength: MAX_BRAND_COMPANY_NAME_LENGTH,
	}),
	footerAddress: string('footerAddress').meta({
		description:
			'The postal address in the footer of every marketing email, one line per line. Commercial mail must carry one.',
		maxLength: MAX_BRAND_ADDRESS_LENGTH,
	}),
	footerSocialLinks: z
		.array(socialLinkSchema, { error: 'footerSocialLinks must be an array' })
		.meta({ maxItems: MAX_BRAND_SOCIAL_LINKS }),
};

const logoSchema = z
	.strictObject({
		url: z.string(),
		width: z.number().nullable().meta({ description: 'Width in pixels, or null.' }),
	})
	.nullable();

export const brandKitSchema = z.strictObject({
	isConfigured: z.boolean().meta({
		description:
			'False until the kit is saved once, in the dashboard or through the API. Until then every field holds its default and emails take only the primary colour, body font, background and width from it.',
	}),
	...designShape,
	logo: logoSchema.meta({
		description: 'The email logo, or null. Set on the brand kit page; the API cannot change it.',
	}),
	logoDark: logoSchema.meta({
		description:
			'The logo for dark mode, or null. Set on the brand kit page; the API cannot change it.',
	}),
});

/**
 * A partial write: a field left out keeps its stored value. Unlike the other
 * request bodies an unknown field is refused rather than ignored, because a
 * misspelt field would leave the kit unchanged while the write succeeds.
 */
export const brandKitUpdateRequestSchema = z
	.strictObject(designShape, {
		error: (issue) =>
			issue.code === 'unrecognized_keys'
				? `Unknown field ${issue.keys[0]}`
				: 'Request body must be a JSON object',
	})
	.partial();

/** The fields `PUT /api/v1/brand-kit` writes. */
export const BRAND_KIT_WRITABLE_FIELDS = Object.keys(designShape) as readonly string[];

/**
 * Fields of the read that a write refuses by name. The logos are media library
 * files, which the API can neither upload nor pick.
 */
export const BRAND_KIT_LOGO_FIELDS: readonly string[] = [
	'logo',
	'logoDark',
	'logoMediaAssetId',
	'logoDarkMediaAssetId',
];
