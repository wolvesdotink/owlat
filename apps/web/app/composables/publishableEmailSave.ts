import type { EditorBlock } from '@owlat/email-builder';
import {
	useEmailHtmlRendering,
	type EmailIdentifier,
	type RenderOptions,
} from './useEmailHtmlRendering';

/**
 * Publishable-email save — the app-side helper shared by the Email template and
 * Transactional email editors (the two surfaces whose `save()` renders HTML,
 * builds translations, derives `linkedBlockIds`, and writes a publishable
 * lifecycle). Kept out of the Email editor bridge so the bridge stays
 * envelope-agnostic — the Saved block editor renders nothing. See
 * docs/adr/0035-email-editor-bridge-module.md.
 */
export interface PublishableEmailSaveArgs {
	/** Which publishable email this is ({ emailType, emailId }). */
	identifier: EmailIdentifier;
	/** The current canvas blocks to render and scan for linked blocks. */
	blocks: EditorBlock[];
	/** Theme + variableType used for both the default render and translations. */
	renderOptions: RenderOptions;
	/** The email's supported languages (translations are built for all but the default). */
	supportedLanguages: string[];
	/** The default language, excluded from the translation set. */
	defaultLanguage: string;
	/** Persist the rendered fields. The surface adds name/subject/content/id. */
	update: (payload: {
		htmlContent: string;
		htmlTranslations: string;
		linkedBlockIds: string[];
	}) => Promise<void>;
}

/** Derive the deduplicated saved-block ids referenced by the canvas blocks. */
function deriveLinkedBlockIds(blocks: EditorBlock[]): string[] {
	return [
		...new Set(
			blocks
				.filter((block) => block.savedBlockRef)
				.map((block) => block.savedBlockRef!.blockId)
		),
	];
}

export async function publishableEmailSave(args: PublishableEmailSaveArgs): Promise<void> {
	const { renderBlocksToHtml, buildHtmlTranslationsForEmail } = useEmailHtmlRendering();

	const htmlContent = renderBlocksToHtml(args.blocks, args.renderOptions);
	const linkedBlockIds = deriveLinkedBlockIds(args.blocks);

	// `buildHtmlTranslationsForEmail` merges each language's text overlay onto the
	// template's PERSISTED content (via api.*.i18n.getForLanguage). Built before
	// this save, a structural block change (add/remove/reorder) would render the
	// translated languages against the OLD structure — one save stale.
	const translationsObject = await buildHtmlTranslationsForEmail(
		args.identifier,
		args.supportedLanguages,
		args.defaultLanguage,
		args.renderOptions
	);
	await args.update({
		htmlContent,
		htmlTranslations: JSON.stringify(translationsObject),
		linkedBlockIds,
	});

	// Now that the new content is persisted, rebuild the translations so each
	// overlay merges onto the new block structure, and persist the corrected set.
	// Skipped when there are no translated languages or nothing actually changed,
	// so the common single-language / no-structural-change save stays one write.
	const otherLanguages = args.supportedLanguages.filter((l) => l !== args.defaultLanguage);
	if (otherLanguages.length === 0) return;

	const freshTranslations = await buildHtmlTranslationsForEmail(
		args.identifier,
		args.supportedLanguages,
		args.defaultLanguage,
		args.renderOptions
	);
	const freshJson = JSON.stringify(freshTranslations);
	if (freshJson !== JSON.stringify(translationsObject)) {
		await args.update({ htmlContent, htmlTranslations: freshJson, linkedBlockIds });
	}
}
