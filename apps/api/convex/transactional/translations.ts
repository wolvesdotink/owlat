import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { getMutationContext, requirePermission, hasPermission } from '../lib/sessionOrganization';
import {
	throwAlreadyExists,
	throwInvalidInput,
	throwNotFound,
} from '../_utils/errors';
import { assertEditableForPublishableChange } from './lifecycle';
import {
	mergeTranslationIntoItem,
	type TranslatableBlockContent,
} from '../emailTemplates/translationMerge';
import { extractTranslatableContent } from '../emailTemplates/i18n';

// Translation structure: subject and per-block translatable text
interface Translation {
	subject: string;
	blocks: Record<string, TranslatableBlockContent>;
}



// Helper to merge translation blocks with main content blocks
function mergeTranslationWithContent(
	contentJson: string,
	translationBlocks: Record<string, TranslatableBlockContent>
): string {
	try {
		const blocks = JSON.parse(contentJson) as Array<{ id: string; type: string; content: Record<string, unknown> }>;
		const mergedBlocks = blocks.map((block) => mergeTranslationIntoItem(block, translationBlocks));
		return JSON.stringify(mergedBlocks);
	} catch {
		return contentJson;
	}
}

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

		const defaultLanguage = email.defaultLanguage ?? 'en';
		const requestedLanguage = args.language ?? defaultLanguage;

		// If requesting default language or no specific language, return main content
		if (requestedLanguage === defaultLanguage) {
			return {
				...email,
				resolvedLanguage: defaultLanguage,
				subject: email.subject,
				content: email.content,
			};
		}

		// Check if translation exists for requested language
		const translations: Record<string, Translation> = email.translations
			? JSON.parse(email.translations)
			: {};

		if (translations[requestedLanguage]) {
			const translation = translations[requestedLanguage];
			// Merge translation text with main content styling
			const mergedContent = mergeTranslationWithContent(email.content, translation.blocks);

			return {
				...email,
				resolvedLanguage: requestedLanguage,
				subject: translation.subject,
				content: mergedContent,
			};
		}

		// Fall back to default language
		return {
			...email,
			resolvedLanguage: defaultLanguage,
			subject: email.subject,
			content: email.content,
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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage transactional email translations');
		const email = await ctx.db.get(args.id);
		if (!email) {
			throwNotFound('Transactional email');
		}

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		// Parse existing translations
		const translations: Record<string, Translation> = email.translations
			? JSON.parse(email.translations)
			: {};

		// Check if translation already exists
		if (translations[args.language]) {
			throwAlreadyExists(`Translation for language "${args.language}" already exists`);
		}

		// Get supported languages array
		const defaultLanguage = email.defaultLanguage ?? 'en';
		const supportedLanguages = email.supportedLanguages ?? [defaultLanguage];

		// Check if the language is already supported
		if (supportedLanguages.includes(args.language)) {
			throwAlreadyExists(`Language "${args.language}" is already supported`);
		}

		// Extract translatable content from blocks
		const blocks = extractTranslatableContent(email.content);

		// Create new translation with copy of default translatable content
		translations[args.language] = {
			subject: email.subject,
			blocks,
		};

		await ctx.db.patch(args.id, {
			translations: JSON.stringify(translations),
			supportedLanguages: [...supportedLanguages, args.language],
			updatedAt: Date.now(),
		});

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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage transactional email translations');
		const email = await ctx.db.get(args.id);
		if (!email) {
			throwNotFound('Transactional email');
		}

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
		const translations: Record<string, Translation> = email.translations
			? JSON.parse(email.translations)
			: {};

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
			translations: JSON.stringify(translations),
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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage transactional email translations');
		const email = await ctx.db.get(args.id);
		if (!email) {
			throwNotFound('Transactional email');
		}

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		const defaultLanguage = email.defaultLanguage ?? 'en';

		// Cannot remove the default language
		if (args.language === defaultLanguage) {
			throwInvalidInput('Cannot remove the default language translation');
		}

		// Parse existing translations
		const translations: Record<string, Translation> = email.translations
			? JSON.parse(email.translations)
			: {};

		// Check if translation exists
		if (!translations[args.language]) {
			throwNotFound('Translation');
		}

		// Remove the translation by creating a new object without the key
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { [args.language]: _, ...remainingTranslations } = translations;

		// Update supported languages
		const supportedLanguages = (email.supportedLanguages ?? [defaultLanguage]).filter(
			(lang) => lang !== args.language
		);

		await ctx.db.patch(args.id, {
			translations: JSON.stringify(remainingTranslations),
			supportedLanguages,
			updatedAt: Date.now(),
		});

		return args.id;
	},
});
