import { v } from 'convex/values';
import { emailTemplateTypeValidator } from '../lib/convexValidators';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getMutationContext, requirePermission, hasPermission } from '../lib/sessionOrganization';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { listResources, countFacet } from '../lib/listing';
import { emailTemplateListing } from './listing';

// Count of templates by type (API-key shell) — the descriptor's `byType` facet
// returns per-type counts plus their `total`.
export const countByTypeByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		const counts = await countFacet(ctx.db, emailTemplateListing, 'byType');
		return counts as Record<string, number>;
	},
});

// Recently edited templates (dashboard widget) — the recent N rows of the
// descriptor's default browse (updatedAt-descending).
export const getRecentByOrganization = authedQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Clamp the page size — a member could otherwise request an arbitrarily
		// large page of templates.
		const result = await listResources(ctx.db, emailTemplateListing, {
			paginationOpts: { numItems: Math.min(args.limit ?? 5, 50), cursor: null },
		});
		return result.page;
	},
});

// Mutation to create a new email template (web UI; authed org members only).
export const createForOrganization = authedMutation({
	args: {
		name: v.string(),
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		content: v.optional(v.string()),
		type: emailTemplateTypeValidator,
		defaultLanguage: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
		const { userId, role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can create email templates');
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.subject) validateStringLength(args.subject, STRING_LIMITS.SUBJECT, 'Subject');

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.create, {
			name: args.name,
			type: args.type,
			subject: args.subject,
			previewText: args.previewText,
			content: args.content,
			defaultLanguage: args.defaultLanguage,
			userId,
		});

		return outcome.templateId;
	},
});

// Mutation to create a new email template from a library preset
export const createFromPreset = authedMutation({
	args: {
		name: v.string(),
		subject: v.string(),
		previewText: v.optional(v.string()),
		content: v.string(),
		type: emailTemplateTypeValidator,
		defaultLanguage: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
		const { userId, role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can create email templates');
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		validateStringLength(args.subject, STRING_LIMITS.SUBJECT, 'Subject');

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.create, {
			name: args.name,
			type: args.type,
			subject: args.subject,
			previewText: args.previewText,
			content: args.content,
			defaultLanguage: args.defaultLanguage,
			userId,
		});

		return outcome.templateId;
	},
});
