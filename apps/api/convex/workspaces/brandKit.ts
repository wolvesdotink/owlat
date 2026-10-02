/**
 * Brand kit (module) — sole writer of the singleton `instanceSettings` row's
 * `brandKit` column, and the writer of its `emailTheme` column for the brand
 * kit page. Sibling of **Organization settings (module)** (`settings.ts`),
 * whose `update` still accepts `emailTheme` from a previous release's open
 * settings tab, and of **Workspace branding** (`branding.ts`), which owns the
 * public-page logo.
 *
 * The kit is the organization's colours, fonts, button style, email logo and
 * footer. `loadBrandKit` resolves it (the stored columns over the shared
 * defaults, the logo assets to their URLs) for every reader: the settings
 * page, the three editors, the server render (`loadEmailTheme`) and the
 * starting blocks of a new email.
 *
 * Entry points:
 *   - `get`             — the resolved kit (every member: every editor reads it).
 *   - `update`          — save the whole kit; requires `settings:manage`.
 *   - `assertCanManage` — the permission check the website import runs first.
 */

import { v } from 'convex/values';
import {
	brandKitDesignProblem,
	resolveBrandKitDesign,
	type BrandKitDesign,
	type BrandKitProblem,
} from '@owlat/shared/brandKit';
import {
	applyBrandKit,
	brandStarterBlocks,
	type BrandLogoAsset,
	type BrandLogos,
} from '@owlat/shared/brandKitBlocks';
import { generateId, type EditorBlock } from '@owlat/shared';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';
import { isWorkspaceLogoMimeType } from '@owlat/shared/workspaceLogo';
import { isExtensionAllowed, isMimeTypeAllowed } from '@owlat/email-scanner';
import { MEDIA_LIBRARY_POLICY, buildSearchableText } from '../lib/mediaLibraryPolicy';
import { storedFileSize } from '../storage/uploads';
import type { Id } from '../_generated/dataModel';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { hasPermission, requireOrgPermission, requirePermission } from '../lib/sessionOrganization';
import { throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { getInstanceSettings, upsertInstanceSettings } from '../lib/instanceSettings';
import { isChatAttachment } from '../chat/attachmentAccess';
import { socialPlatformValidator } from '../lib/validators/brandKit';
import { parseContentBlocks } from '../emailBlocks/module';

export interface BrandKitView {
	design: BrandKitDesign;
	logos: BrandLogos;
}

async function resolveLogo(
	db: QueryCtx['db'],
	assetId: Id<'mediaAssets'> | undefined
): Promise<BrandLogoAsset | null> {
	if (!assetId) return null;
	const asset = await db.get(assetId);
	// A logo deleted from the media library reads as no logo.
	if (!asset || isChatAttachment(asset)) return null;
	return {
		url: asset.url,
		storageId: asset.storageId,
		mediaAssetId: asset._id,
		...(asset.width ? { width: asset.width } : {}),
	};
}

/** The resolved kit: what every reader of the brand kit goes through. */
export async function loadBrandKit(ctx: { db: QueryCtx['db'] }): Promise<BrandKitView> {
	const settings = await getInstanceSettings(ctx.db);
	const design = resolveBrandKitDesign(settings?.emailTheme, settings?.brandKit);
	const light = await resolveLogo(ctx.db, settings?.brandKit?.logoMediaAssetId);
	// A dark logo alone is not a logo: it only replaces the light one in dark mode.
	const dark = light ? await resolveLogo(ctx.db, settings?.brandKit?.logoDarkMediaAssetId) : null;
	return { design, logos: { light, dark } };
}

/**
 * The content a new email is created with. A blank one (`content` absent)
 * starts with the kit's logo and footer; given blocks (a template preset) are
 * restyled with the kit. Without a saved kit `content` comes back unchanged.
 */
export async function brandedNewEmailContent(
	ctx: { db: QueryCtx['db'] },
	content: string | undefined,
	opts: { blockTypes?: readonly string[] } = {}
): Promise<string | undefined> {
	const kit = await loadBrandKit(ctx);
	if (!kit.design.isConfigured) return content;
	const newId = () => generateId('block');
	if (content === undefined) {
		// Only the Block types the email's editor offers (`blockTypes`).
		const blocks = brandStarterBlocks(kit.design, kit.logos, newId).filter(
			(block) => !opts.blockTypes || opts.blockTypes.includes(block.type)
		);
		return blocks.length > 0 ? JSON.stringify(blocks) : undefined;
	}
	const blocks = parseContentBlocks(content);
	if (blocks.length === 0) return content;
	return JSON.stringify(applyBrandKit(blocks as EditorBlock[], kit.design).blocks);
}

// all-members: every editor (template, transactional, saved block) reads the
// kit for its swatches, new-block styles and logo/footer blocks.
export const get = authedQuery({
	args: {},
	handler: async (ctx): Promise<BrandKitView> => loadBrandKit(ctx),
});

const PROBLEM_MESSAGES: Record<BrandKitProblem, string> = {
	invalidColor: 'Every brand colour must be a hex colour such as #c4785a',
	tooManySwatches: 'A brand kit has at most six extra swatches',
	unknownFont: 'Pick the fonts from the list the brand kit offers',
	buttonOutOfRange: 'The button radius or padding is out of range',
	widthOutOfRange: 'The email width must be between 400 and 800 px',
	companyNameTooLong: 'The company name is too long',
	addressTooLong: 'The address is too long',
	tooManySocialLinks: 'A brand kit has at most eight social links',
	invalidSocialUrl: 'Every social link must be a full http(s) address',
};

async function assertLogoAsset(ctx: QueryCtx, assetId: Id<'mediaAssets'>): Promise<void> {
	const asset = await ctx.db.get(assetId);
	if (!asset || isChatAttachment(asset)) throwInvalidInput('The logo is not in the media library');
	if (!asset.mimeType.startsWith('image/')) throwInvalidInput('A logo must be an image');
}

export const update = authedMutation({
	args: {
		primaryColor: v.string(),
		secondaryColor: v.string(),
		textColor: v.string(),
		backgroundColor: v.string(),
		linkColor: v.string(),
		swatches: v.array(v.string()),
		headingFontFamily: v.string(),
		bodyFontFamily: v.string(),
		buttonRadius: v.number(),
		buttonPaddingX: v.number(),
		buttonPaddingY: v.number(),
		baseWidth: v.number(),
		footerCompanyName: v.string(),
		footerAddress: v.string(),
		footerSocialLinks: v.array(v.object({ platform: socialPlatformValidator, url: v.string() })),
		logoMediaAssetId: v.optional(v.id('mediaAssets')),
		logoDarkMediaAssetId: v.optional(v.id('mediaAssets')),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can change the brand kit'
		);
		const { logoMediaAssetId, logoDarkMediaAssetId, ...design } = args;
		const normalized = {
			...design,
			swatches: design.swatches.map((c) => c.toLowerCase()),
			footerCompanyName: design.footerCompanyName.trim(),
			footerAddress: design.footerAddress.trim(),
			footerSocialLinks: design.footerSocialLinks.map((l) => ({ ...l, url: l.url.trim() })),
		};
		const problem = brandKitDesignProblem(normalized);
		if (problem) throwInvalidInput(PROBLEM_MESSAGES[problem]);
		if (logoDarkMediaAssetId && !logoMediaAssetId) {
			throwInvalidInput('Set the main logo before a dark-mode version');
		}
		if (logoMediaAssetId) await assertLogoAsset(ctx, logoMediaAssetId);
		if (logoDarkMediaAssetId) await assertLogoAsset(ctx, logoDarkMediaAssetId);

		const emailTheme = {
			primaryColor: normalized.primaryColor,
			fontFamily: normalized.bodyFontFamily,
			backgroundColor: normalized.backgroundColor,
			baseWidth: normalized.baseWidth,
		};
		const brandKit = {
			secondaryColor: normalized.secondaryColor,
			textColor: normalized.textColor,
			linkColor: normalized.linkColor,
			swatches: normalized.swatches,
			headingFontFamily: normalized.headingFontFamily,
			buttonRadius: normalized.buttonRadius,
			buttonPaddingX: normalized.buttonPaddingX,
			buttonPaddingY: normalized.buttonPaddingY,
			footerCompanyName: normalized.footerCompanyName,
			footerAddress: normalized.footerAddress,
			footerSocialLinks: normalized.footerSocialLinks,
			...(logoMediaAssetId ? { logoMediaAssetId } : {}),
			...(logoDarkMediaAssetId ? { logoDarkMediaAssetId } : {}),
		};

		const existing = await getInstanceSettings(ctx.db);
		const changes: Record<string, { from: unknown; to: unknown }> = {};
		for (const [key, to] of Object.entries({ emailTheme, brandKit })) {
			const from = existing?.[key as 'emailTheme' | 'brandKit'] ?? null;
			if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
		}
		const settingsId = await upsertInstanceSettings(ctx, { emailTheme, brandKit });
		if (Object.keys(changes).length > 0) {
			await recordAuditLog(ctx, {
				userId: session.userId,
				action: 'settings.updated',
				resource: 'settings',
				resourceId: settingsId,
				detailsBlob: JSON.stringify({ changes }),
			});
		}
		return null;
	},
});

/**
 * The website import's permission check: an action cannot read a session
 * itself, so it asks here with its own identity. Returns who is importing, for
 * the rate limit and the media library row.
 */
export const assertCanManage = internalQuery({
	args: {},
	handler: async (ctx): Promise<{ userId: string; activeOrganizationId: string }> => {
		const session = await requireOrgPermission(
			ctx,
			'settings:manage',
			'Only owners and admins can change the brand kit'
		);
		return { userId: session.userId, activeOrganizationId: session.activeOrganizationId };
	},
});

/**
 * Register an image the server fetched itself (the website import,
 * `brandKitImport.ts`) as a media library asset. The same
 * file policy and byte scan as an upload apply; the blob has no browser upload
 * receipt, so this binds one to the asset, which is what lets deleting the
 * asset delete the blob.
 */
export const registerFetchedImage = internalMutation({
	args: {
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		userId: v.string(),
		organizationId: v.string(),
	},
	handler: async (ctx, args): Promise<{ mediaAssetId: Id<'mediaAssets'>; url: string }> => {
		// The import only takes logo formats (the action checked their bytes).
		if (
			!isWorkspaceLogoMimeType(args.mimeType) ||
			!isExtensionAllowed(args.filename, MEDIA_LIBRARY_POLICY) ||
			!isMimeTypeAllowed(args.mimeType, MEDIA_LIBRARY_POLICY)
		) {
			throwInvalidInput(`File type not allowed: ${args.filename}`);
		}
		const fileSize = await storedFileSize(ctx, args.storageId);
		if (fileSize <= 0 || fileSize > MAX_LIBRARY_FILE_BYTES) {
			throwInvalidInput(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`);
		}
		const url = await ctx.storage.getUrl(args.storageId);
		if (!url) throwInvalidState('Failed to resolve storage URL');
		const now = Date.now();
		const mediaAssetId = await ctx.db.insert('mediaAssets', {
			storageId: args.storageId,
			filename: args.filename,
			mimeType: args.mimeType,
			fileSize,
			url,
			tags: ['brand-kit'],
			uploadedBy: args.userId,
			searchableText: buildSearchableText(args.filename, undefined, ['brand-kit']),
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('storageUploads', {
			userId: args.userId,
			organizationId: args.organizationId,
			status: 'bound',
			storageId: args.storageId,
			resourceKey: `mediaAssets:${mediaAssetId}`,
		});
		await ctx.scheduler.runAfter(0, internal.mediaAssets.scanAssetBytes, {
			assetId: mediaAssetId,
			storageId: args.storageId,
		});
		return { mediaAssetId, url };
	},
});
