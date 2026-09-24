/**
 * Workspace branding (module) — sole writer of the singleton
 * `instanceSettings` row's logo columns (`logoStorageId`,
 * `logoDarkStorageId`). Sibling of **Organization settings (module)**, which
 * owns the other settings columns.
 *
 * The logo replaces the Owlat mark on the pages people reach without an
 * account: sign-in, unsubscribe, preferences and invitations (#810). A person
 * on those pages knows the workspace, not the product it runs on.
 *
 * Entry points:
 *   - `get`         — the logo URLs, for the settings page (auth-gated, live).
 *   - `setLogo`     — bind an uploaded file as the light or dark logo;
 *                     requires `settings:manage` (owner/admin).
 *   - `removeLogo`  — clear one variant and delete its file; removing the
 *                     main logo takes the dark one with it.
 *   - `verifyLogoBytes` / `rejectLogo` — the byte check that runs after
 *                     `setLogo`, because a mutation cannot read a blob.
 *
 * `resolveWorkspaceLogo` is the shared read the public recipient-sender
 * query uses, so the public pages and the settings preview cannot disagree.
 */

import { v } from 'convex/values';
import {
	MAX_WORKSPACE_LOGO_BYTES,
	isWorkspaceLogoMimeType,
	workspaceLogoBytesProblem,
	type WorkspaceLogoVariant,
} from '@owlat/shared/workspaceLogo';
import { internalAction, internalMutation, type QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { throwInvalidInput } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { consumeUpload, deleteOwnedUpload } from '../storage/uploads';

const variantValidator = v.union(v.literal('light'), v.literal('dark'));

const COLUMN = {
	light: 'logoStorageId',
	dark: 'logoDarkStorageId',
} as const satisfies Record<WorkspaceLogoVariant, keyof Doc<'instanceSettings'>>;

/** The upload receipt key a logo file is bound under; one per variant. */
function resourceKey(variant: WorkspaceLogoVariant): string {
	return `instanceSettings:${COLUMN[variant]}`;
}

export interface WorkspaceLogo {
	/** The logo for light backgrounds, or `null` when none is set. */
	logoUrl: string | null;
	/** The logo for dark backgrounds, or `null` to fall back to `logoUrl`. */
	logoDarkUrl: string | null;
}

/** Public URLs for the logo files on the settings row. */
export async function resolveWorkspaceLogo(
	ctx: QueryCtx,
	settings: Doc<'instanceSettings'> | null
): Promise<WorkspaceLogo> {
	const url = async (storageId: Id<'_storage'> | undefined) =>
		storageId ? await ctx.storage.getUrl(storageId) : null;
	const logoUrl = await url(settings?.logoStorageId);
	// A dark logo alone is not a logo: every page starts from the light one.
	const logoDarkUrl = logoUrl ? await url(settings?.logoDarkStorageId) : null;
	return { logoUrl, logoDarkUrl };
}

// all-members: the logo is shown to anyone on the public pages; the settings
// card only needs it live.
export const get = authedQuery({
	args: {},
	handler: async (ctx): Promise<WorkspaceLogo> =>
		resolveWorkspaceLogo(ctx, await ctx.db.query('instanceSettings').first()),
});

export const setLogo = authedMutation({
	args: {
		storageId: v.id('_storage'),
		variant: variantValidator,
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can change the workspace logo'
		);
		// The type is the one storage recorded from the upload request, because
		// that is the Content-Type the public URL serves the file with. A type
		// named separately in these args could say PNG over a blob stored as
		// `text/html`, and the byte check would pass while the URL served HTML.
		const stored = await ctx.db.system.get(args.storageId);
		if (!stored) throwInvalidInput('Uploaded blob is missing or expired');
		const mimeType = stored.contentType ?? '';
		if (!isWorkspaceLogoMimeType(mimeType)) {
			throwInvalidInput('A logo must be a PNG, JPEG or SVG file');
		}
		if (stored.size <= 0) throwInvalidInput('The logo file is empty');
		if (stored.size > MAX_WORKSPACE_LOGO_BYTES) {
			throwInvalidInput(`A logo can be at most ${MAX_WORKSPACE_LOGO_BYTES / 1024} KB`);
		}

		const column = COLUMN[args.variant];
		const existing = await ctx.db.query('instanceSettings').first();
		// A dark logo alone is never shown, and nothing could remove it: the
		// settings card only offers the dark slot once a main logo is set.
		if (args.variant === 'dark' && !existing?.logoStorageId) {
			throwInvalidInput('Set the main logo before a dark-mode version');
		}

		const key = resourceKey(args.variant);
		await consumeUpload(ctx, args.storageId, session, key);

		const now = Date.now();
		const previous = existing?.[column];
		let settingsId: Id<'instanceSettings'>;
		if (existing) {
			await ctx.db.patch(existing._id, { [column]: args.storageId, updatedAt: now });
			settingsId = existing._id;
		} else {
			settingsId = await ctx.db.insert('instanceSettings', {
				[column]: args.storageId,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (previous && previous !== args.storageId) {
			await deleteOwnedUpload(ctx, previous, key);
		}
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.updated',
			resource: 'settings',
			resourceId: settingsId,
			detailsBlob: JSON.stringify({
				changes: { [column]: { from: previous ? 'set' : null, to: 'set' } },
			}),
		});

		await ctx.scheduler.runAfter(0, internal.workspaces.branding.verifyLogoBytes, {
			storageId: args.storageId,
			variant: args.variant,
			mimeType,
		});
		return null;
	},
});

export const removeLogo = authedMutation({
	args: { variant: variantValidator },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can change the workspace logo'
		);
		const existing = await ctx.db.query('instanceSettings').first();
		if (!existing) return null;
		// Removing the main logo takes the dark one with it. Left behind, the
		// dark file would be unreachable (it is never served without a main
		// logo, so the card cannot offer to remove it) and would come back
		// unasked the next time a main logo is set.
		const variants: WorkspaceLogoVariant[] =
			args.variant === 'light' ? ['light', 'dark'] : ['dark'];
		const cleared = variants.filter((variant) => existing[COLUMN[variant]]);
		if (cleared.length === 0) return null;

		await ctx.db.patch(existing._id, {
			...Object.fromEntries(cleared.map((variant) => [COLUMN[variant], undefined])),
			updatedAt: Date.now(),
		});
		for (const variant of cleared) {
			const storageId = existing[COLUMN[variant]];
			if (storageId) await deleteOwnedUpload(ctx, storageId, resourceKey(variant));
		}
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.updated',
			resource: 'settings',
			resourceId: existing._id,
			detailsBlob: JSON.stringify({
				changes: Object.fromEntries(
					cleared.map((variant) => [COLUMN[variant], { from: 'set', to: null }])
				),
			}),
		});
		return null;
	},
});

/**
 * Read the stored logo and take it down if its bytes are not the declared
 * image type, or are an SVG that could run script. Fails open on a read
 * error, like the media library's scan: a storage hiccup must not delete a
 * logo an admin just set.
 */
export const verifyLogoBytes = internalAction({
	args: { storageId: v.id('_storage'), variant: variantValidator, mimeType: v.string() },
	handler: async (ctx, args) => {
		let bytes: Uint8Array;
		try {
			const blob = await ctx.storage.get(args.storageId);
			if (!blob) return;
			bytes = new Uint8Array(await blob.arrayBuffer());
		} catch {
			return;
		}
		const problem = workspaceLogoBytesProblem(args.mimeType, bytes);
		if (problem === null) return;
		await ctx.runMutation(internal.workspaces.branding.rejectLogo, {
			storageId: args.storageId,
			variant: args.variant,
			reason: problem,
		});
	},
});

export const rejectLogo = internalMutation({
	args: { storageId: v.id('_storage'), variant: variantValidator, reason: v.string() },
	handler: async (ctx, args) => {
		const column = COLUMN[args.variant];
		const existing = await ctx.db.query('instanceSettings').first();
		// Only take down the file this check was for; a newer upload may have
		// replaced it already, and that one has its own check scheduled.
		if (existing && existing[column] === args.storageId) {
			await ctx.db.patch(existing._id, { [column]: undefined, updatedAt: Date.now() });
			await recordAuditLog(ctx, {
				userId: 'system',
				action: 'settings.updated',
				resource: 'settings',
				resourceId: existing._id,
				detailsBlob: JSON.stringify({
					changes: { [column]: { from: 'set', to: null } },
					rejected: args.reason,
				}),
			});
		}
		await deleteOwnedUpload(ctx, args.storageId, resourceKey(args.variant));
	},
});
