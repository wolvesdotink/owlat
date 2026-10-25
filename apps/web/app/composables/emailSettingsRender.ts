import type { EditorBlock } from '@owlat/email-builder';
import { parseStoredBlocks } from '@owlat/email-builder/stored-blocks';
import {
	extractTranslatableContent,
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '@owlat/api/translationMerge';
import { EMAIL_RENDERER_VERSION } from '@owlat/email-renderer/version';
import { isRecord } from '@owlat/shared/utils/guards';
import { decodeJsonText, guardDecoder } from '@owlat/worker-protocol/decodeJson';
import {
	requireTranslationOverlays,
	type StoredTranslationOverlay,
} from '~/utils/translationOverlays';
import { useEmailHtmlRendering, type RenderOptions } from './useEmailHtmlRendering';

/**
 * The delivery HTML behind a template Settings save. The send path delivers a
 * language straight from the stored `htmlContent` / `htmlTranslations`, so a
 * save that changes which languages exist, their subjects or the default
 * language has to store the HTML rendered from the state it leaves, in the
 * same write (the contract `publishableEmailSave.ts` and `translationSave.ts`
 * follow for the editor and the translation table).
 */

/** One language's overlay as the row stores it; the page edits only part of it. */
type SettingsOverlay = StoredTranslationOverlay;

/** A template's language data: what every language's HTML is rendered from. */
export interface SettingsLanguageState {
	/** Default-language block JSON; every language is rendered on its structure. */
	content: string;
	subject: string;
	defaultLanguage: string;
	supportedLanguages: string[];
	translations: Record<string, SettingsOverlay>;
}

/** What the new default language's swap writes besides the row's text. */
export interface SwappedDelivery {
	htmlContent: string;
	plainTextContent: string;
	htmlTranslations: string;
	/** The renderer version that produced the HTML. */
	rendererVersion: number;
}

/**
 * The row's overlays; throws when the blob cannot be read, so a save renders
 * nothing (and writes nothing) over translations it could not see.
 */
export function parseSettingsOverlays(blob: string | undefined): Record<string, SettingsOverlay> {
	return requireTranslationOverlays(blob);
}

const blockListDecoder = guardDecoder(
	(value): value is unknown[] => Array.isArray(value),
	'$: expected an array'
);

function isBlockLikeItem(value: unknown): value is BlockLikeItem {
	return (
		isRecord(value) &&
		typeof value['id'] === 'string' &&
		typeof value['type'] === 'string' &&
		isRecord(value['content'])
	);
}

/**
 * `content` with an overlay's Block text merged in; an entry that is not a
 * Block has no id for overlay text to address and stays as it is. Content
 * that is not a Block list throws: nothing can be rendered from it, so the
 * save writes nothing rather than delivery HTML for an empty email.
 */
function mergeOverlayIntoContent(
	content: string,
	blocks: Record<string, TranslatableBlockContent>
): string {
	const decoded = decodeJsonText(content, blockListDecoder);
	if (!decoded.ok) throw new Error('Could not read the email content to merge a translation into');
	return JSON.stringify(
		decoded.value.map((block) =>
			isBlockLikeItem(block) ? mergeTranslationIntoItem(block, blocks) : block
		)
	);
}

function overlaid(content: string, overlay: SettingsOverlay | undefined): EditorBlock[] {
	const blocks = parseStoredBlocks(content);
	if (!overlay) return blocks;
	return (blocks as unknown as BlockLikeItem[]).map((block) =>
		mergeTranslationIntoItem(block, overlay.blocks ?? {})
	) as unknown as EditorBlock[];
}

/**
 * The `htmlTranslations` blob for `state`: every supported language but the
 * default, its overlay text on the default content. A blank translated
 * subject sends the default subject, as the Settings page tells the author.
 */
export function renderHtmlTranslations(
	state: SettingsLanguageState,
	renderOptions: RenderOptions
): string {
	const { renderBlocksToHtml } = useEmailHtmlRendering();
	const rendered: Record<string, { htmlContent: string; subject: string }> = {};
	for (const language of state.supportedLanguages) {
		if (language === state.defaultLanguage) continue;
		const overlay = state.translations[language];
		rendered[language] = {
			htmlContent: renderBlocksToHtml(overlaid(state.content, overlay), renderOptions),
			subject: overlay?.subject?.trim() || state.subject,
		};
	}
	return JSON.stringify(rendered);
}

/**
 * `state` after `language` becomes the default, as the backend's
 * `setDefaultLanguagePatch` stores it: the overlay's text merged into the
 * body, the outgoing default demoted to an overlay, both languages supported.
 */
export function promoteLanguage(
	state: SettingsLanguageState,
	language: string
): SettingsLanguageState {
	const promoted = state.translations[language];
	if (!promoted) throw new Error(`No ${language} translation to make the default language`);
	const others = { ...state.translations };
	delete others[language];
	return {
		content: mergeOverlayIntoContent(state.content, promoted.blocks ?? {}),
		subject: promoted.subject ?? '',
		defaultLanguage: language,
		supportedLanguages: [
			...state.supportedLanguages,
			...[state.defaultLanguage, language].filter(
				(lang) => !state.supportedLanguages.includes(lang)
			),
		],
		translations: {
			...others,
			[state.defaultLanguage]: {
				subject: state.subject,
				blocks: extractTranslatableContent(state.content),
			},
		},
	};
}

/**
 * Everything the send path reads for `state` once `language` is its default:
 * the new default's HTML and text/plain body (the author's own text wins, as
 * in the editor), and every other language's HTML.
 */
export function renderSwappedDelivery(
	state: SettingsLanguageState,
	language: string,
	plainTextOverride: string | undefined,
	renderOptions: RenderOptions
): SwappedDelivery {
	const { renderBlocksToHtml, renderBlocksToPlainText } = useEmailHtmlRendering();
	const swapped = promoteLanguage(state, language);
	const blocks = parseStoredBlocks(swapped.content);
	return {
		htmlContent: renderBlocksToHtml(blocks, renderOptions),
		plainTextContent: renderBlocksToPlainText(blocks, plainTextOverride),
		htmlTranslations: renderHtmlTranslations(swapped, renderOptions),
		rendererVersion: EMAIL_RENDERER_VERSION,
	};
}
