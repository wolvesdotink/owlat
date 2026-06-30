import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { getMutationContext, requirePermission, hasPermission } from '../lib/sessionOrganization';
import { throwNotFound, throwAlreadyExists, throwInvalidState } from '../_utils/errors';
import { assertEditableForPublishableChange } from './lifecycle';
import { mergeTranslationIntoItem, type TranslatableBlockContent } from './translationMerge';

// Re-exported for backward compatibility with this module's prior public surface.
export { mergeTranslationIntoItem };
export type { TranslatableBlockContent };

export interface Block {
	id: string;
	type: string;
	content: {
		html?: string;
		text?: string; // Button text in block content
		alt?: string;
		columns?: Array<Array<{ id: string; type: string; content: Record<string, unknown> }>>;
		items?: Array<{ id: string; type: string; content: Record<string, unknown> }>;
		[key: string]: unknown;
	};
}

// Translation structure: subject, previewText, and per-block translatable text
export interface Translation {
	subject: string;
	previewText?: string;
	blocks: Record<string, TranslatableBlockContent>;
}

// Helper to merge translation blocks with main content blocks
// Takes the block structure/styling from main content and applies translated text
export function mergeTranslationWithContent(
	contentJson: string,
	translationBlocks: Record<string, TranslatableBlockContent>
): string {
	try {
		const blocks = JSON.parse(contentJson) as Block[];
		const mergedBlocks = blocks.map((block) => mergeTranslationIntoItem(block, translationBlocks));
		return JSON.stringify(mergedBlocks);
	} catch {
		return contentJson;
	}
}

// Recursive helper to extract translatable content from any block-like item
export function extractFromItem(
	item: { id: string; type: string; content: Record<string, unknown> },
	translatableContent: Record<string, TranslatableBlockContent>
): void {
	const content: TranslatableBlockContent = {};

	if (item.type === 'text' && item.content['html']) {
		content.html = item.content['html'] as string;
	} else if (item.type === 'button' && item.content['text']) {
		content.buttonText = item.content['text'] as string;
	} else if (item.type === 'image' && item.content['alt']) {
		content.alt = item.content['alt'] as string;
	} else if (item.type === 'columns' && Array.isArray(item.content['columns'])) {
		// Recursively extract from column items
		for (const column of item.content['columns'] as Array<
			Array<{ id: string; type: string; content: Record<string, unknown> }>
		>) {
			for (const columnItem of column) {
				extractFromItem(columnItem, translatableContent);
			}
		}
	} else if (item.type === 'container' && Array.isArray(item.content['items'])) {
		// Recursively extract from container items
		for (const containerItem of item.content['items'] as Array<{
			id: string;
			type: string;
			content: Record<string, unknown>;
		}>) {
			extractFromItem(containerItem, translatableContent);
		}
	}

	// Only add if there's translatable content
	if (Object.keys(content).length > 0) {
		translatableContent[item.id] = content;
	}
}

export function extractTranslatableContent(blocksJson: string): Record<string, TranslatableBlockContent> {
	try {
		const blocks = JSON.parse(blocksJson) as Block[];
		const translatableContent: Record<string, TranslatableBlockContent> = {};

		for (const block of blocks) {
			extractFromItem(block, translatableContent);
		}

		return translatableContent;
	} catch {
		return {};
	}
}

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

		const defaultLanguage = template.defaultLanguage ?? 'en';
		const requestedLanguage = args.language ?? defaultLanguage;

		// If requesting default language or no specific language, return main content
		if (requestedLanguage === defaultLanguage) {
			return {
				...template,
				resolvedLanguage: defaultLanguage,
				subject: template.subject,
				previewText: template.previewText,
				content: template.content,
			};
		}

		// Check if translation exists for requested language
		const translations: Record<string, Translation> = template.translations
			? JSON.parse(template.translations)
			: {};

		if (translations[requestedLanguage]) {
			const translation = translations[requestedLanguage];
			// Merge translation text with main content styling
			const mergedContent = mergeTranslationWithContent(template.content, translation.blocks);

			return {
				...template,
				resolvedLanguage: requestedLanguage,
				subject: translation.subject,
				previewText: translation.previewText,
				content: mergedContent,
			};
		}

		// Fall back to default language
		return {
			...template,
			resolvedLanguage: defaultLanguage,
			subject: template.subject,
			previewText: template.previewText,
			content: template.content,
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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage template translations');
		const template = await ctx.db.get(args.templateId);
		if (!template) {
			throwNotFound('Email template');
		}

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		// Parse existing translations
		const translations: Record<string, Translation> = template.translations
			? JSON.parse(template.translations)
			: {};

		// Check if translation already exists
		if (translations[args.language]) {
			throwAlreadyExists(`Translation for language "${args.language}" already exists`);
		}

		// Get supported languages array
		const supportedLanguages = template.supportedLanguages ?? [template.defaultLanguage ?? 'en'];

		// Check if the language is already supported
		if (supportedLanguages.includes(args.language)) {
			throwAlreadyExists(`Language "${args.language}" is already supported`);
		}

		// Extract translatable content from blocks
		const blocks = extractTranslatableContent(template.content);

		// Create new translation with copy of default translatable content
		translations[args.language] = {
			subject: template.subject,
			previewText: template.previewText,
			blocks,
		};

		await ctx.db.patch(args.templateId, {
			translations: JSON.stringify(translations),
			supportedLanguages: [...supportedLanguages, args.language],
			updatedAt: Date.now(),
		});

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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage template translations');
		const template = await ctx.db.get(args.templateId);
		if (!template) {
			throwNotFound('Email template');
		}

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
		const translations: Record<string, Translation> = template.translations
			? JSON.parse(template.translations)
			: {};

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
			translations: JSON.stringify(translations),
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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage template translations');
		const template = await ctx.db.get(args.templateId);
		if (!template) {
			throwNotFound('Email template');
		}

		assertEditableForPublishableChange(template, args.forceWhilePublished);

		const defaultLanguage = template.defaultLanguage ?? 'en';

		// Cannot remove the default language
		if (args.language === defaultLanguage) {
			throwInvalidState('Cannot remove the default language translation');
		}

		// Parse existing translations
		const translations: Record<string, Translation> = template.translations
			? JSON.parse(template.translations)
			: {};

		// Check if translation exists
		if (!translations[args.language]) {
			throwNotFound('Translation');
		}

		// Remove the translation by creating a new object without the key
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { [args.language]: _, ...remainingTranslations } = translations;

		// Update supported languages
		const supportedLanguages = (template.supportedLanguages ?? [defaultLanguage]).filter(
			(lang) => lang !== args.language
		);

		await ctx.db.patch(args.templateId, {
			translations: JSON.stringify(remainingTranslations),
			supportedLanguages,
			updatedAt: Date.now(),
		});

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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can manage template translations');
		const template = await ctx.db.get(args.templateId);
		if (!template) {
			throwNotFound('Email template');
		}

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
		const translations: Record<string, Translation> =
			template.translations ? JSON.parse(template.translations) : {};

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
			translations: JSON.stringify(updatedTranslations),
			updatedAt: Date.now(),
		});

		return args.templateId;
	},
});
