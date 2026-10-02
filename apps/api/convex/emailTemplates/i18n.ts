import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import {
	assertEditableForPublishableChange,
	withRenderedTranslations,
} from '../lib/publishableEmail';
import { assertContentRevision } from '../lib/contentRevision';
import { rendererVersionArg } from '../lib/rendererVersion';
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
		// Ignored: the server renders every language's delivery HTML from the
		// stored overlays in this write (lib/publishableEmail.ts). Still accepted
		// so older clients keep working.
		htmlContent: v.optional(v.string()),
		// Ignored, like htmlContent.
		rendererVersion: rendererVersionArg,
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

		const patch = await withRenderedTranslations(
			ctx,
			template,
			addTranslationPatch(template, args.language, TEMPLATE_TRANSLATABLE_FIELDS),
			'personalization'
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
		// Ignored: the server renders every language's delivery HTML from the
		// stored overlays in this write (lib/publishableEmail.ts). Still accepted
		// so older clients keep working.
		htmlContent: v.optional(v.string()),
		// Ignored, like htmlContent.
		rendererVersion: rendererVersionArg,
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

		const patch = await withRenderedTranslations(
			ctx,
			template,
			updateTranslationPatch(template, args, TEMPLATE_TRANSLATABLE_FIELDS),
			'personalization'
		);
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

		const patch = await withRenderedTranslations(
			ctx,
			template,
			removeTranslationPatch(template, args.language),
			'personalization'
		);
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
		// Ignored: the server renders the swapped row's HTML, text/plain body and
		// every other language's HTML in this write, so the send path never pairs
		// the new subject with the old language's body. Still accepted so older
		// clients keep working.
		htmlContent: v.optional(v.string()),
		plainTextContent: v.optional(v.string()),
		htmlTranslations: v.optional(v.string()),
		rendererVersion: rendererVersionArg,
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

		const patch = setDefaultLanguagePatch(template, args.language, TEMPLATE_TRANSLATABLE_FIELDS);
		if (patch) {
			await ctx.db.patch(
				args.templateId,
				await withRenderedTranslations(ctx, template, patch, 'personalization')
			);
		}
		return args.templateId;
	},
});
