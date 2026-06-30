import { v } from 'convex/values';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { nanoid } from 'nanoid';
import { getOptional } from './lib/env';
import {
	getMutationContext,
	requirePermission,
	hasPermission,
} from './lib/sessionOrganization';
import { throwNotFound, throwInvalidInput, throwInvalidState } from './_utils/errors';

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

/**
 * Create a share link for an email template or transactional email.
 * Snapshots the current HTML content at creation time.
 */
export const createShareLink = authedMutation({
	args: {
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args) => {
		const session = await getMutationContext(ctx);
		requirePermission(hasPermission(session.role, 'shareLinks:manage'), 'Only owners and admins can create share links');

		// Exactly one must be set
		if (!args.emailTemplateId && !args.transactionalEmailId) {
			throwInvalidInput('Either emailTemplateId or transactionalEmailId is required');
		}
		if (args.emailTemplateId && args.transactionalEmailId) {
			throwInvalidInput('Only one of emailTemplateId or transactionalEmailId can be set');
		}

		let htmlContent: string | undefined;
		let subject: string;
		let previewText: string | undefined;

		if (args.emailTemplateId) {
			const template = await ctx.db.get(args.emailTemplateId);
			if (!template) { throwNotFound('Email template'); }
			if (!template.htmlContent) {
				throwInvalidState('Template must be saved at least once before sharing');
			}
			htmlContent = template.htmlContent;
			subject = template.subject;
			previewText = template.previewText;
		} else {
			const email = await ctx.db.get(args.transactionalEmailId!);
			if (!email) { throwNotFound('Transactional email'); }
			if (!email.htmlContent) {
				throwInvalidState('Email must be saved at least once before sharing');
			}
			htmlContent = email.htmlContent;
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
			subject,
			previewText,
			expiresAt: now + FORTY_EIGHT_HOURS_MS,
			createdBy: session.userId,
			createdAt: now,
		});

		const siteUrl = getOptional('SITE_URL') || 'http://localhost:3000';

		return {
			shareLinkId,
			token,
			url: `${siteUrl}/share?token=${encodeURIComponent(token)}`,
		};
	},
});

/**
 * Revoke a share link.
 */
export const revokeShareLink = authedMutation({
	args: {
		shareLinkId: v.id('shareLinks'),
	},
	handler: async (ctx, args) => {
		const session = await getMutationContext(ctx);
		requirePermission(hasPermission(session.role, 'shareLinks:manage'), 'Only owners and admins can revoke share links');
		const shareLink = await ctx.db.get(args.shareLinkId);
		if (!shareLink) { throwNotFound('Share link'); }

		await ctx.db.patch(args.shareLinkId, {
			revokedAt: Date.now(),
		});
	},
});

/**
 * List share links for an email template or transactional email.
 */
export const listShareLinks = authedQuery({
	args: {
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args) => {
		let links;
		if (args.emailTemplateId) {
			const template = await ctx.db.get(args.emailTemplateId);
			if (!template) return [];

			links = await ctx.db
				.query('shareLinks')
				.withIndex('by_email_template', (q) => q.eq('emailTemplateId', args.emailTemplateId))
				.collect();
		} else if (args.transactionalEmailId) {
			const email = await ctx.db.get(args.transactionalEmailId);
			if (!email) return [];

			links = await ctx.db
				.query('shareLinks')
				.withIndex('by_transactional_email', (q) =>
					q.eq('transactionalEmailId', args.transactionalEmailId)
				)
				.collect();
		} else {
			return [];
		}

		// Sort by createdAt desc
		return links.sort((a, b) => b.createdAt - a.createdAt);
	},
});
