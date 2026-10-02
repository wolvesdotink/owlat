/**
 * Rendering a publishable email (`emailTemplates`, `transactionalEmails`) on
 * the server: the default-language HTML, each translation's HTML and the
 * text/plain body, all from the stored (sanitized) blocks and overlays. The
 * editor save, publish, duplicate, translation writes (lib/publishableEmail.ts)
 * and the saved-block rerender (emailBlocks/rendering.ts) all render here.
 */

import { renderEmailHtml, renderPlainText } from '@owlat/email-renderer';
import type { EmailTheme } from '@owlat/shared';
import type { MutationCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';
import { parseContentBlocks } from '../emailBlocks/module';
import {
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '../emailTemplates/translationMerge';

/** Templates personalize per contact; transactional emails interpolate data. */
export type PublishableEmailVariableType = 'personalization' | 'data';

/** The columns a render reads. */
export type RenderablePublishableEmail = {
	content: string;
	subject: string;
	translations?: string;
	supportedLanguages?: string[];
	defaultLanguage?: string;
	/** Author's hand-written text/plain body — never overwritten by a render. */
	plainTextOverride?: string;
};

export interface RenderedPublishableEmail {
	html: string;
	htmlTranslations: string | undefined;
	/** Regenerated text/plain body; absent when the author wrote their own. */
	plainTextContent: string | undefined;
}

/**
 * Overlay a language's translated text onto the default-language blocks. Falls
 * back to the unmerged blocks if the translation has no per-block map.
 */
function mergeTranslatedBlocks(
	defaultBlocks: BlockLikeItem[],
	translationBlocks: Record<string, TranslatableBlockContent> | undefined
): BlockLikeItem[] {
	if (!translationBlocks) return defaultBlocks;
	return defaultBlocks.map((block) => mergeTranslationIntoItem(block, translationBlocks));
}

/**
 * Render a publishable email row: the default-language body, then each
 * supported language's translated text overlaid onto the default block
 * structure, exactly as `getForLanguage` merges at save time. The two tables
 * differ only by `variableType`.
 *
 * Cost: one full render per language with an overlay, plus the default, and
 * every render walks every block. The editor save, publish and duplicate run
 * this inside a mutation, so a large template translated into many languages
 * spends that many renders of the mutation's execution budget. Measured on the
 * seed fixtures repeated to 200 blocks, one render took about 13 ms (Bun, warm
 * JIT; the Convex isolate is slower cold). There is no cap on
 * `supportedLanguages`; if very large multi-language templates start to time
 * out, cap the languages or move the translation renders to the rerender pool.
 */
export function renderPublishableEmail(
	row: RenderablePublishableEmail,
	variableType: PublishableEmailVariableType,
	theme: EmailTheme | undefined
): RenderedPublishableEmail {
	const blocks = parseContentBlocks(row.content);
	const html = renderEmailHtml(blocks as Parameters<typeof renderEmailHtml>[0], {
		variableType,
		theme,
	});
	// The text/plain body tracks the blocks exactly as the html does — EXCEPT
	// when the author wrote their own, which a render must not clobber.
	const plainTextContent = row.plainTextOverride?.trim()
		? undefined
		: renderPlainText(blocks as Parameters<typeof renderPlainText>[0]);

	let htmlTranslations: string | undefined;
	if (row.translations && row.supportedLanguages?.length) {
		const translationsObj: Record<string, { htmlContent: string; subject: string }> = {};
		try {
			const translations = JSON.parse(row.translations) as Record<
				string,
				{ subject?: string; blocks?: Record<string, TranslatableBlockContent> }
			>;

			for (const lang of row.supportedLanguages) {
				if (lang === row.defaultLanguage) continue;
				const langTranslation = translations[lang];
				if (!langTranslation) continue;

				const translatedBlocks = mergeTranslatedBlocks(
					blocks as BlockLikeItem[],
					langTranslation.blocks
				);
				translationsObj[lang] = {
					htmlContent: renderEmailHtml(
						translatedBlocks as unknown as Parameters<typeof renderEmailHtml>[0],
						{ variableType, theme }
					),
					subject: langTranslation.subject ?? row.subject,
				};
			}
		} catch {
			// Invalid translations JSON — skip; render still proceeds.
		}

		if (Object.keys(translationsObj).length > 0) {
			htmlTranslations = JSON.stringify(translationsObj);
		}
	}

	return { html, htmlTranslations, plainTextContent };
}

/**
 * `renderPublishableEmail` for a mutation: a row whose blocks the renderer
 * cannot handle is refused as invalid input instead of failing the write with
 * an internal error. The editor renders the same blocks with the same renderer
 * before it saves, so only a malformed API payload lands here.
 */
export function renderForWrite(
	row: RenderablePublishableEmail,
	variableType: PublishableEmailVariableType,
	theme: EmailTheme | undefined
): RenderedPublishableEmail {
	try {
		return renderPublishableEmail(row, variableType, theme);
	} catch {
		throwInvalidInput('The email content could not be rendered.');
	}
}

/** The instance's email theme, which every render of a stored email uses. */
export async function loadEmailTheme(ctx: {
	db: MutationCtx['db'];
}): Promise<EmailTheme | undefined> {
	const settings = await ctx.db.query('instanceSettings').first();
	return settings?.emailTheme ?? undefined;
}
