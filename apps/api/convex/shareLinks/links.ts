import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { nanoid } from 'nanoid';
import { getOptional } from '../lib/env';
import { requirePermission, hasPermission } from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { UNSTAMPED_RENDERER_VERSION } from '../lib/rendererVersion';
import { getLive, getLiveOrThrow } from '../lib/softDelete';

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

/**
 * The bodies below are shared with the root `shareLinks.ts` shims, which keep
 * the previous paths answering for one release. Each builder makes its own
 * `shareLinks:manage` check and declares its own arguments before calling
 * them, so the shims hold the same floor and validator, and the source scans
 * that read a builder's inline arguments see both.
 */
type ShareLinkTarget = {
	emailTemplateId?: Id<'emailTemplates'>;
	transactionalEmailId?: Id<'transactionalEmails'>;
};

/**
 * Snapshot the target's saved HTML, with the renderer version the source row
 * records for it, into a new share link.
 */
export async function insertShareLink(ctx: MutationCtx, args: ShareLinkTarget, createdBy: string) {
	// Exactly one must be set
	if (!args.emailTemplateId && !args.transactionalEmailId) {
		throwInvalidInput('Either emailTemplateId or transactionalEmailId is required');
	}
	if (args.emailTemplateId && args.transactionalEmailId) {
		throwInvalidInput('Only one of emailTemplateId or transactionalEmailId can be set');
	}

	let htmlContent: string | undefined;
	let rendererVersion: number | undefined;
	let subject: string;
	let previewText: string | undefined;

	if (args.emailTemplateId) {
		const template = await getLiveOrThrow(ctx, args.emailTemplateId, 'Email template');
		if (!template.htmlContent) {
			throwInvalidState('Template must be saved at least once before sharing');
		}
		htmlContent = template.htmlContent;
		rendererVersion = template.rendererVersion;
		subject = template.subject;
		previewText = template.previewText;
	} else {
		const email = await getOrThrow(ctx, args.transactionalEmailId!, 'Transactional email');
		if (!email.htmlContent) {
			throwInvalidState('Email must be saved at least once before sharing');
		}
		htmlContent = email.htmlContent;
		rendererVersion = email.rendererVersion;
		subject = email.subject;
	}

	const token = nanoid(24);
	const now = Date.now();

	const shareLinkId = await ctx.db.insert('shareLinks', {
		targetType: args.emailTemplateId ? 'emailTemplate' : 'transactionalEmail',
		emailTemplateId: args.emailTemplateId,
		transactionalEmailId: args.transactionalEmailId,
		token,
		htmlContent,
		rendererVersion: rendererVersion ?? UNSTAMPED_RENDERER_VERSION,
		subject,
		previewText,
		expiresAt: now + FORTY_EIGHT_HOURS_MS,
		createdBy,
		createdAt: now,
	});

	const siteUrl = getOptional('SITE_URL') || 'http://localhost:3000';

	return {
		shareLinkId,
		token,
		url: `${siteUrl}/share?token=${encodeURIComponent(token)}`,
	};
}

export async function markShareLinkRevoked(ctx: MutationCtx, shareLinkId: Id<'shareLinks'>) {
	await getOrThrow(ctx, shareLinkId, 'Share link');

	await ctx.db.patch(shareLinkId, {
		revokedAt: Date.now(),
	});
}

/** The target's share links, newest first, raw tokens included. */
export async function readShareLinks(ctx: QueryCtx, args: ShareLinkTarget) {
	let links;
	if (args.emailTemplateId) {
		const template = await getLive(ctx, args.emailTemplateId);
		if (!template) return [];

		links = await ctx.db
			.query('shareLinks')
			.withIndex('by_email_template', (q) => q.eq('emailTemplateId', args.emailTemplateId))
			.collect(); // bounded: share links for one template (few)
	} else if (args.transactionalEmailId) {
		const email = await ctx.db.get(args.transactionalEmailId);
		if (!email) return [];

		links = await ctx.db
			.query('shareLinks')
			.withIndex('by_transactional_email', (q) =>
				q.eq('transactionalEmailId', args.transactionalEmailId)
			)
			.collect(); // bounded: share links for one template (few)
	} else {
		return [];
	}

	// Sort by createdAt desc
	return links.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Create a share link for an email template or transactional email.
 * Snapshots the current HTML content at creation time, with the renderer
 * version the source row records for it.
 */
export const createShareLink = authedMutation({
	args: {
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'shareLinks:manage'),
			'Only owners and admins can create share links'
		);
		return await insertShareLink(ctx, args, session.userId);
	},
});

/**
 * Revoke a share link.
 */
export const revokeShareLink = authedMutation({
	args: {
		shareLinkId: v.id('shareLinks'),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'shareLinks:manage'),
			'Only owners and admins can revoke share links'
		);
		await markShareLinkRevoked(ctx, args.shareLinkId);
	},
});

/**
 * List share links for an email template or transactional email.
 *
 * Gated on `shareLinks:manage` — each row carries the raw `token`, the bearer
 * capability for the unauthenticated `/share` route, so listing is held to the
 * same permission that minting (`createShareLink`) and revoking
 * (`revokeShareLink`) already require. The only reader (ShareLinksPopover) is an
 * admin surface whose create/revoke actions already demand this permission.
 */
// token-safe: the token is the payload, not a leak. A share link exists to be
// handed out, the popover's copy action rebuilds the /share URL from it, and
// only a shareLinks:manage holder (who can mint and revoke links) receives it.
// publicReturnRedaction.test.ts lists this as a reviewed exception.
export const listShareLinks = authedQuery({
	args: {
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'shareLinks:manage'),
			'Only owners and admins can view share links'
		);
		return await readShareLinks(ctx, args);
	},
});
