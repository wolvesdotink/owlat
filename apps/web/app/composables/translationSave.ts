import type { EditorBlock } from '@owlat/email-builder';
import { parseStoredBlocks } from '@owlat/email-builder/stored-blocks';
import {
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '@owlat/api/translationMerge';
import { EMAIL_RENDERER_VERSION } from '@owlat/email-renderer/version';
import {
	readTranslationOverlays,
	type StoredTranslationOverlay,
} from '~/utils/translationOverlays';
import { useEmailHtmlRendering, type RenderOptions } from './useEmailHtmlRendering';

/**
 * Translation-table save — what the translation manager writes for one
 * language. The same contract as the editor save (`publishableEmailSave.ts`):
 * the overlay text and the delivery HTML rendered from it come from ONE frozen
 * copy of the server row, and go out in ONE mutation that names that row's
 * content revision. The backend refuses the write when the row has moved on,
 * so a translation can never be stored beside HTML rendered from other
 * content, and a write built on an old row is never merged over a newer one.
 */

/** One language's translatable text, as a translation write sends it. */
export interface TranslationOverlay {
	subject: string;
	previewText?: string;
	blocks: Record<string, TranslatableBlockContent>;
}

/** The overlay value a translation-table cell edits. */
export type TranslationField =
	| { kind: 'subject' }
	| { kind: 'previewText' }
	| { kind: 'block'; blockId: string; property: keyof TranslatableBlockContent };

/** One cell's new value. */
export interface TranslationFieldEdit {
	field: TranslationField;
	value: string;
}

/** The server row a translation write is built on. */
export interface TranslationBase {
	/** Default-language block JSON; every language is rendered on its structure. */
	content: string;
	/** Default subject, which a newly added language starts from. */
	subject: string;
	translations: Record<string, StoredTranslationOverlay>;
	/**
	 * Set when the row's `translations` could not be read: the cells show no
	 * text, and no write is built on the base, since it would replace the
	 * language's stored text with what this read could not see.
	 */
	translationsUnreadable?: true;
	/** The row's content revision; the write is refused if it moved. */
	revision: number;
}

/** The row fields `translationBaseOf` reads. */
interface TranslatableRow {
	content: string;
	subject: string;
	translations?: string;
	contentRevision?: number;
}

/** Freeze the server row into the base a write is built on. */
export function translationBaseOf(row: TranslatableRow): TranslationBase {
	const translations = readTranslationOverlays(row.translations);
	return {
		content: row.content,
		subject: row.subject,
		translations: translations ?? {},
		...(translations ? {} : { translationsUnreadable: true as const }),
		revision: row.contentRevision ?? 0,
	};
}

/** The stored value of `field` in `overlay`, or '' when there is none. */
export function readOverlayField(
	overlay: StoredTranslationOverlay | undefined,
	field: TranslationField
): string {
	if (!overlay) return '';
	if (field.kind === 'subject') return overlay.subject ?? '';
	if (field.kind === 'previewText') return overlay.previewText ?? '';
	return overlay.blocks?.[field.blockId]?.[field.property] ?? '';
}

/** A copy of `overlay` with the edits applied; the input is left untouched. */
function applyEdits(
	overlay: StoredTranslationOverlay | undefined,
	edits: readonly TranslationFieldEdit[]
): TranslationOverlay {
	const blocks: Record<string, TranslatableBlockContent> = {};
	for (const [blockId, text] of Object.entries(overlay?.blocks ?? {}))
		blocks[blockId] = { ...text };
	const next: TranslationOverlay = {
		subject: overlay?.subject ?? '',
		...(overlay?.previewText !== undefined ? { previewText: overlay.previewText } : {}),
		blocks,
	};
	for (const { field, value } of edits) {
		if (field.kind === 'subject') next.subject = value;
		else if (field.kind === 'previewText') next.previewText = value;
		else next.blocks[field.blockId] = { ...next.blocks[field.blockId], [field.property]: value };
	}
	return next;
}

/** Render one language: its overlay text on the default content's structure. */
function renderLanguageHtml(
	content: string,
	blocks: Record<string, TranslatableBlockContent>,
	renderOptions: RenderOptions
): string {
	const { renderBlocksToHtml } = useEmailHtmlRendering();
	const merged = (parseStoredBlocks(content) as unknown as BlockLikeItem[]).map((block) =>
		mergeTranslationIntoItem(block, blocks)
	);
	return renderBlocksToHtml(merged as unknown as EditorBlock[], renderOptions);
}

/** The single write for edited cells of one language. */
export interface TranslationUpdatePayload {
	language: string;
	subject: string;
	previewText?: string;
	/** JSON of the language's whole per-block overlay. */
	blocks: string;
	htmlContent: string;
	/** The renderer version that produced `htmlContent`. */
	rendererVersion: number;
	expectedContentRevision: number;
}

/**
 * Build the write for `edits` to `language` synchronously from `base`, so the
 * payload cannot pick up anything that changes after the save started.
 */
export function buildTranslationUpdate(
	base: TranslationBase,
	language: string,
	edits: readonly TranslationFieldEdit[],
	renderOptions: RenderOptions
): TranslationUpdatePayload {
	if (base.translationsUnreadable) {
		throw new Error('Could not read the translations stored on the email');
	}
	const overlay = applyEdits(base.translations[language], edits);
	return {
		language,
		subject: overlay.subject,
		...(overlay.previewText !== undefined ? { previewText: overlay.previewText } : {}),
		blocks: JSON.stringify(overlay.blocks),
		htmlContent: renderLanguageHtml(base.content, overlay.blocks, renderOptions),
		rendererVersion: EMAIL_RENDERER_VERSION,
		expectedContentRevision: base.revision,
	};
}

/**
 * The write that adds a language. The backend seeds the new overlay with the
 * default text, so its HTML is the default content rendered as it stands.
 */
export function buildLanguageAdd(
	base: TranslationBase,
	renderOptions: RenderOptions
): { htmlContent: string; rendererVersion: number; expectedContentRevision: number } {
	return {
		htmlContent: renderLanguageHtml(base.content, {}, renderOptions),
		rendererVersion: EMAIL_RENDERER_VERSION,
		expectedContentRevision: base.revision,
	};
}
