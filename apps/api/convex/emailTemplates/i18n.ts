import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow, throwNotFound } from '../_utils/errors';
import { assertEditableForPublishableChange } from './lifecycle';
import { type TranslatableBlockContent } from './translationMerge';
import {
	addLanguage,
	extractTranslatableContent,
	mergeTranslationWithContent,
	parseTranslations,
	removeLanguage,
	resolveForLanguage,
	serializeTranslations,
	TEMPLATE_TRANSLATABLE_FIELDS,
	type Translation,
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
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage template translations'
		);
		const template = await getOrThrow(ctx, args.templateId, 'Email template');

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		const patch = addLanguage(template, args.language, TEMPLATE_TRANSLATABLE_FIELDS);

		await ctx.db.patch(args.templateId, { ...patch, updatedAt: Date.now() });

		return args.templateId;
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
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage template translations'
		);
		const template = await getOrThrow(ctx, args.templateId, 'Email template');

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		const defaultLanguage = template.defaultLanguage ?? 'en';

		// If updating the default language, update the main fields
		// Note: Block content with styling is updated via the regular update mutation
		if (args.language === defaultLanguage) {
			const updates: {
				subject?: string;
				previewText?: string;
				updatedAt: number;
			} = { updatedAt: Date.now() };

			if (args.subject !== undefined) {
				updates.subject = args.subject.trim();
			}
			if (args.previewText !== undefined) {
				updates.previewText = args.previewText.trim();
			}

			await ctx.db.patch(args.templateId, updates);
			return args.templateId;
		}

		// For non-default languages, update the translations object
		const translations = parseTranslations(template.translations);

		const translation = translations[args.language];
		if (!translation) {
			throwNotFound('Translation');
		}

		if (args.subject !== undefined) {
			translation.subject = args.subject.trim();
		}
		if (args.previewText !== undefined) {
			translation.previewText = args.previewText.trim();
		}
		if (args.blocks !== undefined) {
			translation.blocks = JSON.parse(args.blocks) as Record<string, TranslatableBlockContent>;
		}

		translations[args.language] = translation;

		await ctx.db.patch(args.templateId, {
			translations: serializeTranslations(translations),
			updatedAt: Date.now(),
		});

		return args.templateId;
	},
});

// Mutation to remove a language translation from an email template
export const removeTranslation = authedMutation({
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

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		const patch = removeLanguage(template, args.language);

		await ctx.db.patch(args.templateId, { ...patch, updatedAt: Date.now() });

		return args.templateId;
	},
});

// Mutation to change the default language of an email template
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

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		const currentDefault = template.defaultLanguage ?? 'en';

		// No change needed if already the default
		if (args.language === currentDefault) {
			return args.templateId;
		}

		// Parse existing translations. A translation entry is the per-block
		// translatable-text overlay ({ subject, previewText?, blocks }) — NOT a
		// full content document. The previous implementation read a nonexistent
		// `.content` field off the translation (always undefined) and would have
		// wiped the template body on the swap.
		const translations = parseTranslations(template.translations);

		// Get the new default's translation overlay
		const newDefault = translations[args.language];

		// Check if the new default language exists in translations
		if (!newDefault) {
			throwNotFound('Translation');
		}

		// The new default's FULL content is the current main content structure
		// with the new language's translatable text merged in. The outgoing
		// default becomes a translation overlay (its translatable text extracted
		// from the current main content), so re-selecting it later round-trips.
		const currentContent = template.content ?? '[]';
		// Overlays created from the Settings page carry only subject/previewText
		// (no per-block text), so guard against a missing `blocks` map — the merge
		// indexes into it per block id and would otherwise throw.
		const newDefaultContent = mergeTranslationWithContent(currentContent, newDefault.blocks ?? {});
		const outgoingDefaultOverlay: Translation = {
			subject: template.subject,
			previewText: template.previewText,
			blocks: extractTranslatableContent(currentContent),
		};

		// Drop the promoted language's overlay; demote the old default to one.
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { [args.language]: _, ...otherTranslations } = translations;
		const updatedTranslations: Record<string, Translation> = {
			...otherTranslations,
			[currentDefault]: outgoingDefaultOverlay,
		};

		await ctx.db.patch(args.templateId, {
			subject: newDefault.subject,
			previewText: newDefault.previewText,
			content: newDefaultContent,
			defaultLanguage: args.language,
			translations: serializeTranslations(updatedTranslations),
			updatedAt: Date.now(),
		});

		return args.templateId;
	},
});
