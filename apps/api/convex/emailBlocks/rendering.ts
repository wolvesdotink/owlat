'use node';

/**
 * Saved-block rerender action. Runs in Node.js so it can call
 * `@owlat/email-renderer`. Enqueued by the saved-block module's
 * `schedule_rerender` effect into the `rerenderBlocksPool` (see
 * `renderingPool.ts`).
 *
 * Per-row failures THROW so the workpool retries the whole job; once
 * retries are exhausted the pool's `onComplete` writes the
 * `htmlRenderState.failureCount` / `lastFailureAt` patch and emits
 * `email_block.rerender_failed`. The pre-ADR-0023 fire-and-forget
 * `logError` swallow is gone.
 *
 * Per ADR-0023.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { renderEmailHtml, renderPlainText } from '@owlat/email-renderer';
import type { EmailTheme } from '@owlat/shared';
import { parseContentBlocks } from './module';
import type { RerenderPatchOutcome } from './renderingPool';
import { currentContentRevision } from '../lib/contentRevision';
import {
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '../emailTemplates/translationMerge';

// ─── Per-language merge ──────────────────────────────────────────────────────
//
// A translation stores only translatable *text* keyed by block id — not a full
// block array. Rendering a non-default language means taking the default
// content's block structure/styling and overlaying the translated text, exactly
// as `getForLanguage` does at save time via `mergeTranslationWithContent`. The
// recursive overlay itself lives in the pure (`'use node'`-safe) shared module
// `emailTemplates/translationMerge`, imported above.

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

// ─── Per-consumer-row rerender ───────────────────────────────────────────────
//
// Templates and transactional emails carry the identical block→HTML rerender
// shape — render the default-language body, then overlay each supported
// language's translated text onto the default block structure and render that
// too. The two differ only by `variableType` (templates personalize, transac-
// tional emails interpolate data) and the per-row `subject`/`content` fields,
// which are read here off the shared shape. Keeping this in one place stops the
// two loops from drifting.

type RerenderableRow = {
	content: string;
	subject: string;
	translations?: string;
	supportedLanguages?: string[];
	defaultLanguage?: string;
	/** Author's hand-written text/plain body — never overwritten by a rerender. */
	plainTextOverride?: string;
};

export function rerenderRow(
	row: RerenderableRow,
	variableType: 'personalization' | 'data',
	theme: EmailTheme | undefined
): { html: string; htmlTranslations: string | undefined; plainTextContent: string | undefined } {
	const blocks = parseContentBlocks(row.content);
	const html = renderEmailHtml(blocks as Parameters<typeof renderEmailHtml>[0], {
		variableType,
		theme,
	});
	// The text/plain body tracks the blocks exactly as the html does — EXCEPT
	// when the author wrote their own, which a saved-block edit must not clobber.
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

				// Overlay this language's translated text onto the default
				// block structure, then render — instead of re-emitting the
				// default-language body for every language.
				const translatedBlocks = mergeTranslatedBlocks(
					blocks as BlockLikeItem[],
					langTranslation.blocks
				);
				const translatedHtml = renderEmailHtml(
					translatedBlocks as unknown as Parameters<typeof renderEmailHtml>[0],
					{ variableType, theme }
				);

				translationsObj[lang] = {
					htmlContent: translatedHtml,
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
 * How many times one job re-reads and re-renders a row that keeps moving under
 * it before giving up and letting the workpool retry the whole job.
 */
export const MAX_RERENDER_ATTEMPTS = 3;

/**
 * Render one consumer row and patch it, guarded by the revision it was
 * rendered from. The render happens outside any transaction, so a write can
 * land between the read and the patch; the patch refuses to overwrite it. When
 * the row moved but is still stale, render again from the current row. Throws
 * once the row has moved on every attempt, so the workpool retries the job and,
 * when its retries run out, records the failure on the row.
 */
export async function rerenderConsumerRow<Row extends RerenderableRow>(deps: {
	load: () => Promise<Row | null>;
	render: (row: Row) => ReturnType<typeof rerenderRow>;
	patch: (row: Row, rendered: ReturnType<typeof rerenderRow>) => Promise<RerenderPatchOutcome>;
}): Promise<RerenderPatchOutcome> {
	for (let attempt = 0; attempt < MAX_RERENDER_ATTEMPTS; attempt++) {
		const row = await deps.load();
		if (!row) return 'gone';
		const outcome = await deps.patch(row, deps.render(row));
		if (outcome !== 'moved') return outcome;
	}
	throw new Error(
		`Consumer row kept changing during the saved-block rerender (${MAX_RERENDER_ATTEMPTS} attempts)`
	);
}

export const reRenderEmails = internalAction({
	args: {
		templateIds: v.array(v.id('emailTemplates')),
		transactionalIds: v.array(v.id('transactionalEmails')),
	},
	handler: async (ctx, args) => {
		// Load the org's email theme once so propagated HTML keeps the same
		// brand styling the editor save path applies — without it the renderer
		// falls back to DEFAULT_THEME and silently reverts the org's
		// primaryColor/fontFamily/backgroundColor/baseWidth on every consumer.
		const theme =
			(await ctx.runQuery(internal.emailBlocks.renderingPool.getEmailTheme, {})) ?? undefined;

		for (const templateId of args.templateIds) {
			await rerenderConsumerRow({
				load: () => ctx.runQuery(internal.emailBlocks.renderingPool.getTemplate, { templateId }),
				render: (template) => rerenderRow(template, 'personalization', theme),
				patch: (template, { html, htmlTranslations, plainTextContent }) =>
					ctx.runMutation(internal.emailBlocks.renderingPool.patchTemplateHtml, {
						templateId,
						htmlContent: html,
						htmlTranslations,
						plainTextContent,
						expectedContentRevision: currentContentRevision(template),
					}),
			});
		}

		for (const emailId of args.transactionalIds) {
			await rerenderConsumerRow({
				load: () =>
					ctx.runQuery(internal.emailBlocks.renderingPool.getTransactionalEmail, { emailId }),
				render: (email) => rerenderRow(email, 'data', theme),
				patch: (email, { html, htmlTranslations, plainTextContent }) =>
					ctx.runMutation(internal.emailBlocks.renderingPool.patchTransactionalHtml, {
						emailId,
						htmlContent: html,
						htmlTranslations,
						plainTextContent,
						expectedContentRevision: currentContentRevision(email),
					}),
			});
		}
	},
});
