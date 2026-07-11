import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow, throwNotFound } from '../_utils/errors';
import { assertEditableForPublishableChange } from './lifecycle';
import { type TranslatableBlockContent } from '../emailTemplates/translationMerge';
import {
	addLanguage,
	parseTranslations,
	removeLanguage,
	resolveForLanguage,
	serializeTranslations,
	TRANSACTIONAL_TRANSLATABLE_FIELDS,
} from '../lib/emailTranslations';

/**
 * Get transactional email content for a specific language
 * Returns the content for the requested language, falling back to default language if not available
 */
export const getForLanguage = authedQuery({
	args: {
		id: v.id('transactionalEmails'),
		language: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const email = await ctx.db.get(args.id);
		if (!email) {
			return null;
		}

		return {
			...email,
			...resolveForLanguage(email, args.language, TRANSACTIONAL_TRANSLATABLE_FIELDS),
		};
	},
});

/**
 * Add a new language translation to a transactional email
 * Copies translatable text from default language as a starting point
 */
export const addTranslation = authedMutation({
	args: {
		id: v.id('transactionalEmails'),
		language: v.string(),
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		const patch = addLanguage(email, args.language, TRANSACTIONAL_TRANSLATABLE_FIELDS);

		await ctx.db.patch(args.id, { ...patch, updatedAt: Date.now() });

		return args.id;
	},
});

/**
 * Update a specific language translation
 * For non-default languages, only updates translatable text (subject, block text)
 */
export const updateTranslation = authedMutation({
	args: {
		id: v.id('transactionalEmails'),
		language: v.string(),
		subject: v.optional(v.string()),
		blocks: v.optional(v.string()), // JSON string of Record<blockId, TranslatableBlockContent>
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		const defaultLanguage = email.defaultLanguage ?? 'en';

		// If updating the default language, update the main fields
		if (args.language === defaultLanguage) {
			const updates: {
				subject?: string;
				updatedAt: number;
			} = { updatedAt: Date.now() };

			if (args.subject !== undefined) {
				updates.subject = args.subject.trim();
			}

			await ctx.db.patch(args.id, updates);
			return args.id;
		}

		// For non-default languages, update the translations object
		const translations = parseTranslations(email.translations);

		const translation = translations[args.language];
		if (!translation) {
			throwNotFound('Translation');
		}

		if (args.subject !== undefined) {
			translation.subject = args.subject.trim();
		}
		if (args.blocks !== undefined) {
			translation.blocks = JSON.parse(args.blocks) as Record<string, TranslatableBlockContent>;
		}

		translations[args.language] = translation;

		await ctx.db.patch(args.id, {
			translations: serializeTranslations(translations),
			updatedAt: Date.now(),
		});

		return args.id;
	},
});

/**
 * Remove a language translation from a transactional email
 */
export const removeTranslation = authedMutation({
	args: {
		id: v.id('transactionalEmails'),
		language: v.string(),
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		const patch = removeLanguage(email, args.language);

		await ctx.db.patch(args.id, { ...patch, updatedAt: Date.now() });

		return args.id;
	},
});
