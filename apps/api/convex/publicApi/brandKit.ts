/**
 * What `/api/v1/brand-kit` reads and writes (`brandKitHttp.ts`), in the public
 * contract's shape.
 *
 * The read is the kit the dashboard reads (`loadBrandKit`). The write merges
 * the fields the request names over the stored kit and stores the result
 * through `writeBrandKit`, the dashboard's own write path, so the same check,
 * normalisation and audit apply; the audit log names the API key as the actor.
 * The logos are kept as they are: the API cannot set them.
 */

import { v, type Infer } from 'convex/values';
import type { BrandKit, BrandKitLogo } from '@owlat/public-contract';
import type { BrandLogoAsset } from '@owlat/shared/brandKitBlocks';
import type { Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { socialPlatformValidator } from '../lib/validators/brandKit';
import { loadBrandKit, writeBrandKit } from '../workspaces/brandKit';
import { spendWriteToken } from './savedBlocks';
import { API_KEY_ACTOR } from './transactionalEmails';

function toLogo(asset: BrandLogoAsset | null): BrandKitLogo | null {
	return asset ? { url: asset.url, width: asset.width ?? null } : null;
}

async function readBrandKit(ctx: { db: QueryCtx['db'] }): Promise<BrandKit> {
	const { design, logos } = await loadBrandKit(ctx);
	return { ...design, logo: toLogo(logos.light), logoDark: toLogo(logos.dark) };
}

export const getForApi = internalQuery({
	args: {},
	handler: async (ctx): Promise<BrandKit> => readBrandKit(ctx),
});

/** The fields a write may name; the HTTP handler has checked their types. */
const patchValidator = v.object({
	primaryColor: v.optional(v.string()),
	secondaryColor: v.optional(v.string()),
	textColor: v.optional(v.string()),
	backgroundColor: v.optional(v.string()),
	linkColor: v.optional(v.string()),
	swatches: v.optional(v.array(v.string())),
	headingFontFamily: v.optional(v.string()),
	bodyFontFamily: v.optional(v.string()),
	buttonRadius: v.optional(v.number()),
	buttonPaddingX: v.optional(v.number()),
	buttonPaddingY: v.optional(v.number()),
	baseWidth: v.optional(v.number()),
	footerCompanyName: v.optional(v.string()),
	footerAddress: v.optional(v.string()),
	footerSocialLinks: v.optional(
		v.array(v.object({ platform: socialPlatformValidator, url: v.string() }))
	),
});

/** A decoded write body: the contract's schema has checked each social link's platform. */
export type BrandKitPatch = Infer<typeof patchValidator>;

type WriteOutcome =
	| { ok: true; kit: BrandKit }
	| { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

export const updateForApi = internalMutation({
	args: { keyId: v.id('apiKeys'), patch: patchValidator },
	handler: async (ctx, args): Promise<WriteOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		const { design, logos } = await loadBrandKit(ctx);
		const { isConfigured: _isConfigured, ...stored } = design;
		// The resolved logos, not the stored ids: a logo deleted from the media
		// library is dropped, as a save on the brand kit page drops it.
		const light = logos.light?.mediaAssetId as Id<'mediaAssets'> | undefined;
		const dark = logos.dark?.mediaAssetId as Id<'mediaAssets'> | undefined;
		await writeBrandKit(
			ctx,
			{
				...stored,
				...args.patch,
				...(light ? { logoMediaAssetId: light } : {}),
				...(dark ? { logoDarkMediaAssetId: dark } : {}),
			},
			API_KEY_ACTOR
		);
		return { ok: true, kit: await readBrandKit(ctx) };
	},
});
