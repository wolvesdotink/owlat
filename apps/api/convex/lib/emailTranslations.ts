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
 * load-or-throw + publish guard + `ctx.db.patch`) and delegates the blob logic
 * here, passing a descriptor of which translatable fields the entity carries.
 * The `*Patch` helpers at the bottom return the complete row patch for each
 * translation mutation, content revision and timestamp included.
 *
 * The delivery HTML is not computed here: each mutation shell renders it on
 * the server from the patched row (`withRenderedTranslations` in
 * `publishableEmail.ts`) and writes it in the same patch, so the overlay and
 * its HTML share one revision.
 */

import { throwAlreadyExists, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { nextContentRevision } from './contentRevision';
import {
	sanitizeOverlayBlocks,
	sanitizeOverlayBlocksJson,
	sanitizeStoredBlocksJson,
} from './emailContentSanitize';
import {
	extractTranslatableContent,
	mergeTranslationIntoItem,
	parseBlockList,
	type TranslatableBlockContent,
} from '../emailTemplates/translationMerge';
import { decodeOverlayBlocks, decodeStoredTranslations, type StoredTranslation } from './emailJson';

export type { TranslatableBlockContent };

/**
 * Per-language translation overlay, as this module writes it. `previewText` is
 * optional: email templates carry it, transactional emails do not. A stored
 * overlay is read back as a {@link StoredTranslation}, whose `subject` and
 * `blocks` older rows may lack.
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
	contentRevision?: number;
}

/** Describes which translatable fields an entity carries. */
interface TranslatableFields {
	/** Whether the entity has a translatable `previewText` field. */
	hasPreviewText: boolean;
}

export const TEMPLATE_TRANSLATABLE_FIELDS: TranslatableFields = { hasPreviewText: true };
export const TRANSACTIONAL_TRANSLATABLE_FIELDS: TranslatableFields = { hasPreviewText: false };

const DEFAULT_LANGUAGE = 'en';

// --- blob (de)serialization -------------------------------------------------

/**
 * A row's overlays. A blob that is not a record of overlays throws: every
 * caller either writes the overlays back (and must not replace a damaged blob
 * with an empty one) or serves a language from them.
 */
export function parseTranslations(blob: string | undefined): Record<string, StoredTranslation> {
	if (!blob) return {};
	const decoded = decodeStoredTranslations(blob);
	if (!decoded.ok) throw new Error(`The stored translations are malformed (${decoded.issue}).`);
	return decoded.value;
}

export function serializeTranslations(translations: Record<string, StoredTranslation>): string {
	return JSON.stringify(translations);
}

// --- merge ------------------------------------------------------------------

// Helper to merge translation blocks with main content blocks.
// Takes the block structure/styling from main content and applies translated text.
// Content that is not a Block list comes back unchanged.
export function mergeTranslationWithContent(
	contentJson: string,
	translationBlocks: Record<string, TranslatableBlockContent>
): string {
	const blocks = parseBlockList(contentJson);
	if (!blocks) return contentJson;
	return JSON.stringify(blocks.map((block) => mergeTranslationIntoItem(block, translationBlocks)));
}

// --- resolve / add / remove ops ---------------------------------------------

/** Fields to spread over an entity doc to present it in a resolved language. */
interface ResolvedTranslation {
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
	fields: TranslatableFields
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
	fields: TranslatableFields
): ResolvedTranslation {
	const defaultLanguage = entity.defaultLanguage ?? DEFAULT_LANGUAGE;
	const requested = requestedLanguage ?? defaultLanguage;

	// Requesting the default language returns the main content unchanged.
	if (requested === defaultLanguage) {
		return buildResolved(
			defaultLanguage,
			entity.subject,
			entity.previewText,
			entity.content,
			fields
		);
	}

	const translations = parseTranslations(entity.translations);
	const translation = translations[requested];
	if (translation) {
		// Merge translation text with the main content's styling. An overlay
		// without its own subject or block text keeps the default's, as the
		// delivery render does.
		const mergedContent = mergeTranslationWithContent(entity.content, translation.blocks ?? {});
		return buildResolved(
			requested,
			translation.subject ?? entity.subject,
			translation.previewText,
			mergedContent,
			fields
		);
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
	fields: TranslatableFields
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

	// Seed the overlay with a copy of the default language's translatable text,
	// sanitized like every other overlay write.
	const blocks = extractTranslatableContent(entity.content);
	sanitizeOverlayBlocks(blocks);
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
	language: string
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
	const { [language]: _removed, ...remainingTranslations } = translations;

	const supportedLanguages = (entity.supportedLanguages ?? [defaultLanguage]).filter(
		(lang) => lang !== language
	);

	return {
		translations: serializeTranslations(remainingTranslations),
		supportedLanguages,
	};
}

// --- mutation patches ---------------------------------------------------------

/**
 * A row patch written by a translation mutation. Every one advances the
 * content revision (translation overlays are editor content) and `updatedAt`.
 * `previewText` is only ever set for entities whose fields carry it.
 */
export interface TranslationPatch {
	subject?: string;
	previewText?: string;
	content?: string;
	defaultLanguage?: string;
	translations?: string;
	supportedLanguages?: string[];
	contentRevision: number;
	updatedAt: number;
}

function revisionStamp(
	row: TranslatableEntity
): Pick<TranslationPatch, 'contentRevision' | 'updatedAt'> {
	return { contentRevision: nextContentRevision(row), updatedAt: Date.now() };
}

/** Patch for adding a language overlay (see `addLanguage`). */
export function addTranslationPatch(
	row: TranslatableEntity,
	language: string,
	fields: TranslatableFields
): TranslationPatch {
	return { ...addLanguage(row, language, fields), ...revisionStamp(row) };
}

/** Patch for removing a language overlay (see `removeLanguage`). */
export function removeTranslationPatch(
	row: TranslatableEntity,
	language: string
): TranslationPatch {
	return { ...removeLanguage(row, language), ...revisionStamp(row) };
}

export interface TranslationUpdate {
	language: string;
	subject?: string;
	previewText?: string;
	/** JSON string of `Record<blockId, TranslatableBlockContent>`. */
	blocks?: string;
}

/**
 * Patch for editing one language's translatable text.
 *
 * For the default language only the main `subject` / `previewText` columns are
 * written; block content with its styling goes through the regular editor
 * `update` mutation. For any other language the overlay's subject, previewText
 * and per-block text are replaced. Throws not_found when that language has no
 * overlay. `previewText` is ignored for entities without that field.
 */
export function updateTranslationPatch(
	row: TranslatableEntity,
	update: TranslationUpdate,
	fields: TranslatableFields
): TranslationPatch {
	const previewText = fields.hasPreviewText ? update.previewText : undefined;
	const defaultLanguage = row.defaultLanguage ?? DEFAULT_LANGUAGE;

	if (update.language === defaultLanguage) {
		return {
			...(update.subject !== undefined ? { subject: update.subject.trim() } : {}),
			...(previewText !== undefined ? { previewText: previewText.trim() } : {}),
			...revisionStamp(row),
		};
	}

	const translations = parseTranslations(row.translations);
	const translation = translations[update.language];
	if (!translation) {
		throwNotFound('Translation');
	}

	if (update.subject !== undefined) {
		translation.subject = update.subject.trim();
	}
	if (previewText !== undefined) {
		translation.previewText = previewText.trim();
	}
	if (update.blocks !== undefined) {
		const blocks = decodeOverlayBlocks(sanitizeOverlayBlocksJson(update.blocks));
		if (!blocks.ok) {
			throwInvalidInput(
				'Translation blocks must be a JSON object of block id to { html?, buttonText?, alt? } text.',
				{ issue: blocks.issue }
			);
		}
		translation.blocks = blocks.value;
	}
	translations[update.language] = translation;

	return { translations: serializeTranslations(translations), ...revisionStamp(row) };
}

/**
 * Patch for promoting a language overlay to the default language, or `null`
 * when `language` already is the default (nothing to write).
 *
 * The new default's full content is the current main content structure with
 * the new language's translatable text merged in. The outgoing default becomes
 * a translation overlay (its translatable text extracted from the current main
 * content), so re-selecting it later round-trips, and both languages stay
 * supported. Throws not_found when the language has no overlay.
 */
export function setDefaultLanguagePatch(
	row: TranslatableEntity,
	language: string,
	fields: TranslatableFields
): TranslationPatch | null {
	const currentDefault = row.defaultLanguage ?? DEFAULT_LANGUAGE;
	if (language === currentDefault) {
		return null;
	}

	// A translation entry is the per-block translatable-text overlay
	// ({ subject, previewText?, blocks }), NOT a full content document. An
	// earlier implementation read a nonexistent `.content` field off the
	// translation (always undefined) and would have wiped the body on the swap.
	const translations = parseTranslations(row.translations);
	const newDefault = translations[language];
	if (!newDefault) {
		throwNotFound('Translation');
	}

	const currentContent = row.content ?? '[]';
	// Overlays created from the Settings page carry only subject/previewText
	// (no per-block text), so guard against a missing `blocks` map: the merge
	// indexes into it per block id and would otherwise throw.
	const newDefaultContent = mergeTranslationWithContent(currentContent, newDefault.blocks ?? {});
	const outgoingDefaultOverlay: Translation = {
		subject: row.subject,
		...(fields.hasPreviewText ? { previewText: row.previewText } : {}),
		blocks: extractTranslatableContent(currentContent),
	};

	// Drop the promoted language's overlay; demote the old default to one.
	const { [language]: _, ...otherTranslations } = translations;
	const updatedTranslations: Record<string, StoredTranslation> = {
		...otherTranslations,
		[currentDefault]: outgoingDefaultOverlay,
	};

	// The demoted default is an overlay like any other, so it stays deliverable.
	// A row without the list restricts nothing and keeps it that way.
	const supportedLanguages = row.supportedLanguages ?? [];
	const missing = row.supportedLanguages
		? [currentDefault, language].filter((lang) => !supportedLanguages.includes(lang))
		: [];

	return {
		subject: newDefault.subject ?? row.subject,
		...(fields.hasPreviewText ? { previewText: newDefault.previewText } : {}),
		content: sanitizeStoredBlocksJson(newDefaultContent),
		defaultLanguage: language,
		translations: serializeTranslations(updatedTranslations),
		...(missing.length > 0 && { supportedLanguages: [...supportedLanguages, ...missing] }),
		...revisionStamp(row),
	};
}
