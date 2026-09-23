import type { EditorBlock } from '@owlat/email-builder';
import {
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '@owlat/api/translationMerge';
import { useEmailHtmlRendering, type RenderOptions } from './useEmailHtmlRendering';

/**
 * Publishable-email save — the app-side helper shared by the Email template and
 * Transactional email editors (the two surfaces whose `save()` renders HTML,
 * builds translations, derives `linkedBlockIds`, and writes a publishable
 * lifecycle). Kept out of the Email editor bridge so the bridge stays
 * envelope-agnostic — the Saved block editor renders nothing. See
 * docs/adr/0035-email-editor-bridge-module.md.
 *
 * Every persisted representation — the block JSON, the default HTML, each
 * language's HTML and the text/plain body — is derived from ONE frozen copy of
 * the draft plus the translation overlays of the row the draft was built on, and
 * written in ONE mutation that names that row's revision. Translations used to
 * be rendered from the persisted (previous) content and patched in by a second
 * write, so a failure between the two left new blocks beside stale translated
 * HTML, and edits typed while translations loaded leaked into the payload.
 */

/** The editable fields, read from the editor refs when the save starts. */
export interface PublishableEmailDraft {
	name: string;
	subject: string;
	blocks: EditorBlock[];
	/** The author's manual text/plain body, or '' to ship the generated one. */
	plainTextOverride: string;
}

/** The server row the draft was built on. */
export interface PublishableEmailBase {
	/** The email's supported languages (translations are built for all but the default). */
	supportedLanguages: string[];
	/** The default language, excluded from the translation set. */
	defaultLanguage: string;
	/** The row's `translations` blob: per-language text overlays keyed by block id. */
	translations: string | undefined;
	/** The row's editor-content revision; the backend rejects the write if it moved. */
	revision: number | undefined;
}

/** The single write: everything the surface's update mutation needs. */
export interface PublishableEmailPayload {
	name: string;
	subject: string;
	content: string;
	htmlContent: string;
	htmlTranslations: string;
	linkedBlockIds: string[];
	plainTextContent: string;
	plainTextOverride: string;
	expectedContentRevision: number | undefined;
}

export interface PublishableEmailSaveArgs {
	draft: PublishableEmailDraft;
	base: PublishableEmailBase;
	/** Theme + variableType used for both the default render and translations. */
	renderOptions: RenderOptions;
	/** Persist the payload. Throw on failure so the editor stays dirty. */
	commit: (payload: PublishableEmailPayload) => Promise<void>;
}

interface TranslationOverlay {
	subject?: string;
	blocks?: Record<string, TranslatableBlockContent>;
}

/** Derive the deduplicated saved-block ids referenced by the canvas blocks. */
function deriveLinkedBlockIds(blocks: EditorBlock[]): string[] {
	return [
		...new Set(
			blocks.filter((block) => block.savedBlockRef).map((block) => block.savedBlockRef!.blockId)
		),
	];
}

function parseOverlays(blob: string | undefined): Record<string, TranslationOverlay> {
	return blob ? (JSON.parse(blob) as Record<string, TranslationOverlay>) : {};
}

/**
 * Build the whole payload synchronously from the draft. Nothing here awaits, so
 * the payload cannot pick up an edit made after the save started.
 */
function buildPublishableEmailPayload(
	draft: PublishableEmailDraft,
	base: PublishableEmailBase,
	renderOptions: RenderOptions
): PublishableEmailPayload {
	const { renderBlocksToHtml, renderBlocksToPlainText } = useEmailHtmlRendering();

	// The editor refs are shared with the live canvas, which mutates them in
	// place; the serialized copy is the one immutable snapshot everything below
	// is rendered from.
	const content = JSON.stringify(draft.blocks);
	const blocks = JSON.parse(content) as EditorBlock[];
	const plainTextOverride = draft.plainTextOverride;

	// Each language overlays its text onto THIS draft's structure, the same
	// merge the backend's getForLanguage applies. A language without an overlay
	// falls back to the default content and subject, as it does there.
	const overlays = parseOverlays(base.translations);
	const htmlTranslations: Record<string, { htmlContent: string; subject: string }> = {};
	for (const language of base.supportedLanguages) {
		if (language === base.defaultLanguage) continue;
		const overlay = overlays[language];
		const languageBlocks = overlay
			? (blocks as unknown as BlockLikeItem[]).map((block) =>
					mergeTranslationIntoItem(block, overlay.blocks ?? {})
				)
			: blocks;
		htmlTranslations[language] = {
			htmlContent: renderBlocksToHtml(languageBlocks as unknown as EditorBlock[], renderOptions),
			subject: overlay?.subject ?? draft.subject,
		};
	}

	return {
		name: draft.name,
		subject: draft.subject,
		content,
		htmlContent: renderBlocksToHtml(blocks, renderOptions),
		htmlTranslations: JSON.stringify(htmlTranslations),
		linkedBlockIds: deriveLinkedBlockIds(blocks),
		plainTextContent: renderBlocksToPlainText(blocks, plainTextOverride),
		plainTextOverride,
		expectedContentRevision: base.revision,
	};
}

export async function publishableEmailSave(args: PublishableEmailSaveArgs): Promise<void> {
	await args.commit(buildPublishableEmailPayload(args.draft, args.base, args.renderOptions));
}
