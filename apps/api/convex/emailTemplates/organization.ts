import { v } from 'convex/values';
import { emailTemplateTypeValidator } from '../lib/convexValidators';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { countFacet } from '../lib/listing';
import { emailTemplateListing } from './listing';
import { brandedNewEmailContent } from '../workspaces/brandKit';

// Count of templates by type (API-key shell) — the descriptor's `byType` facet
// returns per-type counts plus their `total`.
// all-members: per-type template counts; the library itself is member-readable.
export const countByTypeByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		const counts = await countFacet(ctx.db, emailTemplateListing, 'byType');
		return counts as Record<string, number>;
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
	handler: async (ctx, args, session): Promise<Id<'emailTemplates'>> => {
		requirePermission(
			hasPermission(session.role, 'templates:manage'),
			'Only owners and admins can create email templates'
		);
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		validateStringLength(args.subject, STRING_LIMITS.SUBJECT, 'Subject');

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.create, {
			name: args.name,
			type: args.type,
			subject: args.subject,
			previewText: args.previewText,
			// The preset, restyled with the brand kit.
			content: await brandedNewEmailContent(ctx, args.content),
			defaultLanguage: args.defaultLanguage,
			userId: session.userId,
		});

		return outcome.templateId;
	},
});
