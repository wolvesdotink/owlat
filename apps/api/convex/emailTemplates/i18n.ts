import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import { assertEditableForPublishableChange } from '../lib/publishableEmail';
import { assertContentRevision } from '../lib/contentRevision';
import {
	addTranslationPatch,
	removeTranslationPatch,
	resolveForLanguage,
	setDefaultLanguagePatch,
	TEMPLATE_TRANSLATABLE_FIELDS,
	updateTranslationPatch,
} from '../lib/emailTranslations';

// Query to get email template content for a specific language
// Returns the content for the requested language, falling back to default language if not available
// For non-default languages, merges translation text with the main content's styling
export const getForLanguage = authedQuery({
	args: {
		templateId: v.id('emailTemplates'),
		language: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const template = await ctx.db.get(args.templateId);
		if (!template) {
			return null;
		}

		return {
			...template,
			...resolveForLanguage(template, args.language, TEMPLATE_TRANSLATABLE_FIELDS),
		};
	},
});

// Mutation to add a new language translation to an email template
// Copies translatable text from default language as a starting point
export const addTranslation = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		language: v.string(), // Language code (e.g., "de", "fr", "es")
		// The new language's delivery HTML, rendered from the row's content (the
		// seeded overlay is the default text). Written with the overlay.
		htmlContent: v.optional(v.string()),
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller built this write on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage template translations'
		);
		const template = await getOrThrow(ctx, args.templateId, 'Email template');
		assertEditableForPublishableChange(template, 'Template', args.forceWhilePublished);
		assertContentRevision(template, args.expectedContentRevision);

		const patch = addTranslationPatch(
			template,
			args.language,
			TEMPLATE_TRANSLATABLE_FIELDS,
			args.htmlContent
		);
		await ctx.db.patch(args.templateId, patch);
		// The revision this write stored; the next write builds on it.
		return { templateId: args.templateId, contentRevision: patch.contentRevision };
	},
});

// Mutation to update a specific language translation
// For non-default languages, only updates translatable text (subject, previewText, block text)
// Block styling is always saved to the main content field
export const updateTranslation = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		language: v.string(),
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		blocks: v.optional(v.string()), // JSON string of Record<blockId, TranslatableBlockContent>
		// The language's delivery HTML, rendered from this overlay on the row's
		// content. Written with the overlay, so the two cannot disagree.
		htmlContent: v.optional(v.string()),
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller built this write on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage template translations'
		);
		const template = await getOrThrow(ctx, args.templateId, 'Email template');
		assertEditableForPublishableChange(template, 'Template', args.forceWhilePublished);
		assertContentRevision(template, args.expectedContentRevision);

		const patch = updateTranslationPatch(template, args, TEMPLATE_TRANSLATABLE_FIELDS);
		await ctx.db.patch(args.templateId, patch);
		// The revision this write stored; the next write builds on it.
		return { templateId: args.templateId, contentRevision: patch.contentRevision };
	},
});

// Mutation to remove a language translation from an email template
export const removeTranslation = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		language: v.string(),
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller built this write on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage template translations'
		);
		const template = await getOrThrow(ctx, args.templateId, 'Email template');
		assertEditableForPublishableChange(template, 'Template', args.forceWhilePublished);
		assertContentRevision(template, args.expectedContentRevision);

		const patch = removeTranslationPatch(template, args.language);
		await ctx.db.patch(args.templateId, patch);
		// The revision this write stored; the next write builds on it.
		return { templateId: args.templateId, contentRevision: patch.contentRevision };
	},
});

// Mutation to change the default language of an email template: the chosen
// overlay becomes the body and the outgoing default becomes an overlay.
export const setDefaultLanguage = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		language: v.string(),
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage template translations'
		);
		const template = await getOrThrow(ctx, args.templateId, 'Email template');
		assertEditableForPublishableChange(template, 'Template', args.forceWhilePublished);

		const patch = setDefaultLanguagePatch(template, args.language, TEMPLATE_TRANSLATABLE_FIELDS);
		if (patch) {
			await ctx.db.patch(args.templateId, patch);
		}
		return args.templateId;
	},
});
