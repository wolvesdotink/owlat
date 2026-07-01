/**
 * Entity-agnostic operations on the per-language `translations` JSON blob shared
 * by email templates (`emailTemplates/i18n.ts`) and transactional emails
 * (`transactional/translations.ts`).
 *
 * A `translations` blob is a `Record<languageCode, Translation>` serialized to a
 * string field. Each `Translation` is a per-block translatable-*text* overlay
 * ({ subject, previewText?, blocks }) — NOT a full content document. Overlaying a
 * non-default language means taking the default content's block structure/styling
 * and replacing the translatable fields (see `mergeTranslationIntoItem`).
 *
 * These helpers are pure (no Convex-runtime imports beyond the shared error
 * throwers), so each entity keeps only a thin authed-mutation shell (auth floor +
 * load-or-throw + id type) and delegates the blob logic here, passing a
 * descriptor of which translatable fields the entity carries.
 */

import { throwAlreadyExists, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { mergeTranslationIntoItem, type TranslatableBlockContent } from '../emailTemplates/translationMerge';

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

/**
 * Per-language translation overlay. `previewText` is optional: email templates
 * carry it, transactional emails do not.
 */
export interface Translation {
	subject: string;
	previewText?: string;
	blocks: Record<string, TranslatableBlockContent>;
}

/**
 * The subset of an email entity document these helpers read. Both
 * `emailTemplates` and `transactionalEmails` rows satisfy it.
 */
export interface TranslatableEntity {
	subject: string;
	previewText?: string;
	content: string;
	translations?: string;
	defaultLanguage?: string;
	supportedLanguages?: string[];
}

/** Describes which translatable fields an entity carries. */
export interface TranslatableFields {
	/** Whether the entity has a translatable `previewText` field. */
	hasPreviewText: boolean;
}

export const TEMPLATE_TRANSLATABLE_FIELDS: TranslatableFields = { hasPreviewText: true };
export const TRANSACTIONAL_TRANSLATABLE_FIELDS: TranslatableFields = { hasPreviewText: false };

const DEFAULT_LANGUAGE = 'en';

// --- blob (de)serialization -------------------------------------------------

export function parseTranslations(blob: string | undefined): Record<string, Translation> {
	return blob ? (JSON.parse(blob) as Record<string, Translation>) : {};
}

export function serializeTranslations(translations: Record<string, Translation>): string {
	return JSON.stringify(translations);
}

// --- translatable-content extraction ---------------------------------------

// Recursive helper to extract translatable content from any block-like item.
export function extractFromItem(
	item: { id: string; type: string; content: Record<string, unknown> },
	translatableContent: Record<string, TranslatableBlockContent>,
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

// Helper to merge translation blocks with main content blocks.
// Takes the block structure/styling from main content and applies translated text.
export function mergeTranslationWithContent(
	contentJson: string,
	translationBlocks: Record<string, TranslatableBlockContent>,
): string {
	try {
		const blocks = JSON.parse(contentJson) as Block[];
		const mergedBlocks = blocks.map((block) => mergeTranslationIntoItem(block, translationBlocks));
		return JSON.stringify(mergedBlocks);
	} catch {
		return contentJson;
	}
}

// --- resolve / add / remove ops ---------------------------------------------

/** Fields to spread over an entity doc to present it in a resolved language. */
export interface ResolvedTranslation {
	resolvedLanguage: string;
	subject: string;
	previewText?: string;
	content: string;
}

function buildResolved(
	resolvedLanguage: string,
	subject: string,
	previewText: string | undefined,
	content: string,
	fields: TranslatableFields,
): ResolvedTranslation {
	return {
		resolvedLanguage,
		subject,
		content,
		...(fields.hasPreviewText ? { previewText } : {}),
	};
}

/**
 * Resolve an entity's presented fields for a requested language. Returns the
 * default content for the default (or unset) language, the translation-merged
 * content when an overlay exists, or the default content as a fallback.
 */
export function resolveForLanguage(
	entity: TranslatableEntity,
	requestedLanguage: string | undefined,
	fields: TranslatableFields,
): ResolvedTranslation {
	const defaultLanguage = entity.defaultLanguage ?? DEFAULT_LANGUAGE;
	const requested = requestedLanguage ?? defaultLanguage;

	// Requesting the default language returns the main content unchanged.
	if (requested === defaultLanguage) {
		return buildResolved(defaultLanguage, entity.subject, entity.previewText, entity.content, fields);
	}

	const translations = parseTranslations(entity.translations);
	const translation = translations[requested];
	if (translation) {
		// Merge translation text with the main content's styling.
		const mergedContent = mergeTranslationWithContent(entity.content, translation.blocks);
		return buildResolved(requested, translation.subject, translation.previewText, mergedContent, fields);
	}

	// Fall back to the default language.
	return buildResolved(defaultLanguage, entity.subject, entity.previewText, entity.content, fields);
}

/**
 * Add a new language overlay, seeded with the default language's translatable
 * text. Returns the `translations` / `supportedLanguages` patch. Throws if the
 * language already has an overlay or is already supported.
 */
export function addLanguage(
	entity: TranslatableEntity,
	language: string,
	fields: TranslatableFields,
): { translations: string; supportedLanguages: string[] } {
	const translations = parseTranslations(entity.translations);

	if (translations[language]) {
		throwAlreadyExists(`Translation for language "${language}" already exists`);
	}

	const defaultLanguage = entity.defaultLanguage ?? DEFAULT_LANGUAGE;
	const supportedLanguages = entity.supportedLanguages ?? [defaultLanguage];

	if (supportedLanguages.includes(language)) {
		throwAlreadyExists(`Language "${language}" is already supported`);
	}

	// Seed the overlay with a copy of the default language's translatable text.
	const blocks = extractTranslatableContent(entity.content);
	translations[language] = {
		subject: entity.subject,
		...(fields.hasPreviewText ? { previewText: entity.previewText } : {}),
		blocks,
	};

	return {
		translations: serializeTranslations(translations),
		supportedLanguages: [...supportedLanguages, language],
	};
}

/**
 * Remove a language overlay. Returns the `translations` / `supportedLanguages`
 * patch. Throws if removing the default language or if the overlay is missing.
 */
export function removeLanguage(
	entity: TranslatableEntity,
	language: string,
): { translations: string; supportedLanguages: string[] } {
	const defaultLanguage = entity.defaultLanguage ?? DEFAULT_LANGUAGE;

	// Cannot remove the default language. (Unified guard — templates historically
	// threw invalid_state here, transactional emails invalid_input; standardized
	// on invalid_input since the offending language is a caller-supplied argument.)
	if (language === defaultLanguage) {
		throwInvalidInput('Cannot remove the default language translation');
	}

	const translations = parseTranslations(entity.translations);
	if (!translations[language]) {
		throwNotFound('Translation');
	}

	// Remove the overlay by creating a new object without the key.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { [language]: _removed, ...remainingTranslations } = translations;

	const supportedLanguages = (entity.supportedLanguages ?? [defaultLanguage]).filter(
		(lang) => lang !== language,
	);

	return {
		translations: serializeTranslations(remainingTranslations),
		supportedLanguages,
	};
}
